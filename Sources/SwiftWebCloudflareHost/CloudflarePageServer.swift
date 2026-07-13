#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif
import HTTPTypes
import Logging
import SwiftWebCore

/// The request a Worker forwards for page serving, decoded from the
/// `__swiftwebRequest` JSON global. JS is a no-interpretation trampoline:
/// the body crosses as base64 so binary payloads survive the string channel.
struct CloudflarePageRequest: Decodable, Sendable {
    let callID: String
    let method: String
    let path: String
    let search: String?
    let scheme: String?
    let host: String?
    let headers: [[String]]
    let bodyBase64: String?
}

/// The response returned to the Worker through `swiftwebPageComplete`.
struct CloudflarePageResponse: Encodable, Sendable {
    let status: Int
    let headers: [[String]]
    let bodyBase64: String
}

/// Serves the app's collected page and service routes inside the Worker:
/// match → session → middleware chain → handler → encode. Mirrors
/// `SwiftWebHostHTTPHandler` on the swift-http-server host, with JSON crossing
/// the JS boundary instead of NIO channels.
struct CloudflarePageServer: Sendable {
    let application: CloudflareWebApplication
    let matcher: WebRouteMatcher
    let chain: WebMiddlewares
    let sessionStorage: CloudflareSessionStorage
    let logger: Logger

    func respond(to raw: CloudflarePageRequest) async -> CloudflarePageResponse {
        guard let method = HTTPRequest.Method(raw.method) else {
            return Self.encode(
                Self.errorResponse(status: .badRequest, reason: "Unsupported HTTP method '\(raw.method)'")
            )
        }

        let bodyBytes: [UInt8]?
        if let bodyBase64 = raw.bodyBase64, !bodyBase64.isEmpty {
            guard let data = Data(base64Encoded: bodyBase64) else {
                return Self.encode(
                    Self.errorResponse(status: .badRequest, reason: "Request body is not valid base64")
                )
            }
            bodyBytes = Array(data)
        } else {
            bodyBytes = nil
        }

        let match = matcher.match(method: method, path: raw.path)
        let headers = Self.headerFields(from: raw.headers)
        let cookieHeader = headers[values: .cookie].joined(separator: "; ")
        let cookies = WebHTTPCookieParser.parse(cookieHeader: cookieHeader)
        let session = CloudflareSessionBox(
            cookieValue: cookies[CloudflareSessionBox.cookieName],
            storage: sessionStorage
        )
        let webRequest = Self.webRequest(
            raw: raw,
            method: method,
            headers: headers,
            cookies: cookies,
            bodyBytes: bodyBytes,
            parameters: match?.parameters ?? WebPathParameters(),
            session: session,
            application: application,
            logger: logger
        )

        let terminal = CloudflarePageErrorResponder(
            next: CloudflarePageRouteResponder(match: match),
            logger: logger
        )
        var response: WebResponse
        do {
            response = try await chain.makeResponder(chainingTo: terminal).respond(to: webRequest)
        } catch let abort as Abort {
            response = Self.errorResponse(status: abort.status, reason: abort.reason ?? abort.status.reasonPhrase)
        } catch {
            logger.error("Middleware chain failed: \(String(describing: error))")
            response = Self.errorResponse(status: .internalServerError, reason: "Something went wrong")
        }
        session.finalize(response: &response)
        return await Self.encodeBuffering(response, logger: logger)
    }

    // MARK: - Request construction

    private static func webRequest(
        raw: CloudflarePageRequest,
        method: HTTPRequest.Method,
        headers: HTTPFields,
        cookies: [String: String],
        bodyBytes: [UInt8]?,
        parameters: WebPathParameters,
        session: CloudflareSessionBox,
        application: CloudflareWebApplication,
        logger: Logger
    ) -> WebRequest {
        let queryString = raw.search.flatMap { $0.isEmpty ? nil : $0 }
        let rawPath = queryString.map { "\(raw.path)?\($0)" } ?? raw.path
        let contentType = headers[.contentType]

        return WebRequest(
            method: method,
            url: WebURL(
                string: rawPath,
                scheme: raw.scheme ?? "https",
                host: raw.host ?? headers[HTTPField.Name("Host")!],
                path: raw.path,
                query: queryString
            ),
            headers: headers,
            cookies: cookies,
            query: WebQueryContainer { type in
                try WebURLEncodedFormDecoder().decode(type, from: queryString ?? "")
            },
            content: WebContentContainer(
                decoder: { type in
                    try Self.decodeContent(type, contentType: contentType, bodyBytes: bodyBytes)
                },
                fieldDecoder: { type, name in
                    throw Abort(
                        .unsupportedMediaType,
                        reason: "Multipart field decoding ('\(name)' as \(type)) is not supported on the Cloudflare host yet"
                    )
                }
            ),
            collectBody: { bodyBytes },
            session: session.webSession,
            hasSession: session.hasExistingSession,
            logger: logger,
            application: application,
            remoteAddress: nil,
            parameters: parameters
        )
    }

    private static func headerFields(from pairs: [[String]]) -> HTTPFields {
        var fields = HTTPFields()
        for pair in pairs {
            guard pair.count == 2, let name = HTTPField.Name(pair[0]) else {
                continue
            }
            fields.append(HTTPField(name: name, value: pair[1]))
        }
        return fields
    }

    private static func decodeContent(
        _ type: any Decodable.Type,
        contentType: String?,
        bodyBytes: [UInt8]?
    ) throws -> any Decodable {
        guard let bodyBytes, !bodyBytes.isEmpty else {
            throw Abort(.badRequest, reason: "Request body is empty")
        }
        let mediaType = contentType?
            .split(separator: ";", maxSplits: 1)
            .first
            .map { slice in
                var trimmed = slice
                while let first = trimmed.first, first.isWhitespace {
                    trimmed = trimmed.dropFirst()
                }
                while let last = trimmed.last, last.isWhitespace {
                    trimmed = trimmed.dropLast()
                }
                return trimmed.lowercased()
            }
        switch mediaType {
        case "application/json":
            return try JSONDecoder().decode(type, from: Data(bodyBytes))
        case "application/x-www-form-urlencoded":
            return try WebURLEncodedFormDecoder().decode(
                type,
                from: String(decoding: bodyBytes, as: UTF8.self)
            )
        default:
            throw Abort(
                .unsupportedMediaType,
                reason: "Content type '\(contentType ?? "none")' is not supported on the Cloudflare host"
            )
        }
    }

    // MARK: - Response encoding

    /// Buffers streaming bodies before encoding: the JS boundary carries one
    /// JSON message per response, so incremental delivery is not available on
    /// this host yet.
    private static func encodeBuffering(_ response: WebResponse, logger: Logger) async -> CloudflarePageResponse {
        if let produce = response.body.stream {
            let collector = CollectingBodyWriter()
            do {
                try await produce(collector)
            } catch {
                logger.error("Streaming body failed: \(String(describing: error))")
                return encode(
                    errorResponse(status: .internalServerError, reason: "Something went wrong")
                )
            }
            var buffered = response
            buffered.body = .init(bytes: await collector.collected())
            return encode(buffered)
        }
        return encode(response)
    }

    private static func encode(_ response: WebResponse) -> CloudflarePageResponse {
        var headerPairs: [[String]] = []
        for field in response.headers {
            headerPairs.append([field.name.rawName, field.value])
        }
        let bytes = response.body.bytes ?? []
        return CloudflarePageResponse(
            status: response.status.code,
            headers: headerPairs,
            bodyBase64: Data(bytes).base64EncodedString()
        )
    }

    static func errorResponse(status: HTTPResponse.Status, reason: String) -> WebResponse {
        struct ErrorBody: Encodable {
            let error: Bool
            let reason: String
        }
        var headers = HTTPFields()
        headers[.contentType] = "application/json; charset=utf-8"
        let body: WebResponse.Body
        do {
            body = .init(data: try JSONEncoder().encode(ErrorBody(error: true, reason: reason)))
        } catch {
            body = .init(string: #"{"error":true,"reason":"Something went wrong"}"#)
        }
        return WebResponse(status: status, headers: headers, body: body)
    }
}

/// The end of the middleware chain: run the matched route or 404.
private struct CloudflarePageRouteResponder: WebResponder {
    let match: WebRouteMatch?

    func respond(to request: WebRequest) async throws -> WebResponse {
        guard let match else {
            throw Abort(.notFound, reason: "Not Found")
        }
        switch match.route.handler {
        case .http(let handler):
            return try await handler(request)
        case .webSocket:
            throw Abort(
                .notImplemented,
                reason: "WebSocket routes are served through the actor WebSocket path on the Cloudflare host"
            )
        }
    }
}

/// Converts errors thrown by routed handlers into responses, mirroring the
/// swift-http-server host's wire shape (`{"error":true,"reason":...}`), so
/// security/CORS headers still decorate error responses.
private struct CloudflarePageErrorResponder: WebResponder {
    let next: any WebResponder
    let logger: Logger

    func respond(to request: WebRequest) async throws -> WebResponse {
        do {
            return try await next.respond(to: request)
        } catch let abort as Abort {
            return CloudflarePageServer.errorResponse(
                status: abort.status,
                reason: abort.reason ?? abort.status.reasonPhrase
            )
        } catch let error as DecodingError {
            logger.debug("Request decoding failed: \(String(describing: error))")
            return CloudflarePageServer.errorResponse(status: .badRequest, reason: "Request payload could not be decoded")
        } catch {
            logger.error("Unhandled route error: \(String(describing: error))")
            return CloudflarePageServer.errorResponse(status: .internalServerError, reason: "Something went wrong")
        }
    }
}

/// Collects a streaming body into memory for the single-message JS boundary.
private actor CollectingBodyChunks {
    private var bytes: [UInt8] = []

    func append(_ chunk: [UInt8]) {
        bytes.append(contentsOf: chunk)
    }

    func all() -> [UInt8] {
        bytes
    }
}

private struct CollectingBodyWriter: WebBodyWriter {
    private let chunks = CollectingBodyChunks()

    func write(_ bytes: [UInt8]) async throws {
        await chunks.append(bytes)
    }

    func collected() async -> [UInt8] {
        await chunks.all()
    }
}
