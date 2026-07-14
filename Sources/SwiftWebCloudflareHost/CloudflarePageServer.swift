#if canImport(FoundationEssentials)
import FoundationEssentials
#elseif canImport(Foundation)
import Foundation
#endif
import HTTPTypes
#if canImport(Logging)
import Logging
#endif
import SwiftWebCore

/// The request a Worker forwards for page serving, read from the
/// `__swiftwebRequest*` string globals. JS is a no-interpretation trampoline:
/// the body crosses as base64 so binary payloads survive the string channel,
/// and headers cross as a `CloudflarePageWire`-encoded flat list — plain
/// strings only, so the boundary needs neither JSON nor Codable in the
/// binary.
struct CloudflarePageRequest: Sendable {
    let callID: String
    let method: String
    let path: String
    let search: String?
    let scheme: String?
    let host: String?
    let headers: [(name: String, value: String)]
    let bodyBase64: String?
}

/// The response returned to the Worker through
/// `swiftwebPageComplete(callID, status, headersWire, bodyBase64)`.
struct CloudflarePageResponse: Sendable {
    let status: Int
    let headersWire: String
    let bodyBase64: String
}

/// The flat string encoding for header lists crossing the JS boundary:
/// alternating name/value entries joined by the ASCII unit separator, which
/// cannot appear in HTTP field names or values.
enum CloudflarePageWire {
    static let separator: Character = "\u{1F}"

    static func encode(_ fields: HTTPFields) -> String {
        var parts: [String] = []
        parts.reserveCapacity(fields.count * 2)
        for field in fields {
            parts.append(field.name.rawName)
            parts.append(field.value)
        }
        return parts.joined(separator: String(separator))
    }

    static func decodeHeaders(_ wire: String) -> [(name: String, value: String)] {
        guard !wire.isEmpty else {
            return []
        }
        let parts = wire.split(separator: separator, omittingEmptySubsequences: false)
        var headers: [(name: String, value: String)] = []
        headers.reserveCapacity(parts.count / 2)
        var index = 0
        while index + 1 < parts.count {
            headers.append((name: String(parts[index]), value: String(parts[index + 1])))
            index += 2
        }
        return headers
    }
}

/// Serves the app's collected page and service routes inside the Worker:
/// match → session → middleware chain → handler → encode. Mirrors
/// `SwiftWebHostHTTPHandler` on the swift-http-server host, with plain-string
/// globals crossing the JS boundary instead of NIO channels.
struct CloudflarePageServer: Sendable {
    let application: CloudflareApplication
    let matcher: RouteMatcher
    let chain: Middlewares
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
            guard let decoded = Base64Coding.decode(bodyBase64) else {
                return Self.encode(
                    Self.errorResponse(status: .badRequest, reason: "Request body is not valid base64")
                )
            }
            bodyBytes = decoded
        } else {
            bodyBytes = nil
        }

        let match = matcher.match(method: method, path: raw.path)
        let headers = Self.headerFields(from: raw.headers)
        let cookieHeader = headers[values: .cookie].joined(separator: "; ")
        let cookies = CookieParser.parse(cookieHeader: cookieHeader)
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
            parameters: match?.parameters ?? PathParameters(),
            session: session,
            application: application,
            logger: logger
        )

        let terminal = CloudflarePageErrorResponder(
            next: CloudflarePageRouteResponder(match: match),
            logger: logger
        )
        var response: Response
        do {
            response = try await chain.makeResponder(chainingTo: terminal).respond(to: webRequest)
        } catch let abort as Abort {
            response = Self.errorResponse(status: abort.status, reason: abort.reason ?? abort.status.reasonPhrase)
        } catch {
            logger.error("Middleware chain failed: \(HostErrorText.of(error))")
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
        parameters: PathParameters,
        session: CloudflareSessionBox,
        application: CloudflareApplication,
        logger: Logger
    ) -> Request {
        let queryString = raw.search.flatMap { $0.isEmpty ? nil : $0 }
        let rawPath = queryString.map { "\(raw.path)?\($0)" } ?? raw.path
        let contentType = headers[.contentType]

        return Request(
            method: method,
            url: RequestURL(
                string: rawPath,
                scheme: raw.scheme ?? "https",
                host: raw.host ?? headers[HTTPField.Name("Host")!],
                path: raw.path,
                query: queryString
            ),
            headers: headers,
            cookies: cookies,
            content: Self.makeContentContainer(contentType: contentType, bodyBytes: bodyBytes),
            collectBody: { bodyBytes },
            session: session.webSession,
            hasSession: session.hasExistingSession,
            logger: logger,
            application: application,
            remoteAddress: nil,
            parameters: parameters
        )
    }

    private static func headerFields(from headers: [(name: String, value: String)]) -> HTTPFields {
        var fields = HTTPFields()
        for header in headers {
            guard let name = HTTPField.Name(header.name) else {
                continue
            }
            fields.append(HTTPField(name: name, value: header.value))
        }
        return fields
    }

    private static func makeContentContainer(
        contentType: String?,
        bodyBytes: [UInt8]?
    ) -> ContentContainer {
        #if hasFeature(Embedded)
        // Codable body decoding is unavailable on the embedded profile.
        ContentContainer()
        #else
        ContentContainer(
            decoder: { type in
                try Self.decodeContent(type, contentType: contentType, bodyBytes: bodyBytes)
            },
            fieldDecoder: { type, _ in
                try Self.decodeContent(type, contentType: contentType, bodyBytes: bodyBytes)
            }
        )
        #endif
    }

    #if !hasFeature(Embedded)
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
        #if !hasFeature(Embedded)
        case "application/json":
            return try JSONDecoder().decode(type, from: Data(bodyBytes))
        case "application/x-www-form-urlencoded":
            return try URLEncodedFormDecoder().decode(
                type,
                from: String(decoding: bodyBytes, as: UTF8.self)
            )
        #endif
        default:
            throw Abort(
                .unsupportedMediaType,
                reason: "Content type '\(contentType ?? "none")' is not supported on the Cloudflare host"
            )
        }
    }

    #endif

    // MARK: - Response encoding

    /// Buffers streaming bodies before encoding: the JS boundary carries one
    /// JSON message per response, so incremental delivery is not available on
    /// this host yet.
    private static func encodeBuffering(_ response: Response, logger: Logger) async -> CloudflarePageResponse {
        if let produce = response.body.stream {
            let collector = CollectingBodyWriter()
            do {
                try await produce(collector)
            } catch {
                logger.error("Streaming body failed: \(HostErrorText.of(error))")
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

    private static func encode(_ response: Response) -> CloudflarePageResponse {
        let bytes = response.body.bytes ?? []
        return CloudflarePageResponse(
            status: response.status.code,
            headersWire: CloudflarePageWire.encode(response.headers),
            bodyBase64: Base64Coding.encode(bytes)
        )
    }

    static func errorResponse(status: HTTPResponse.Status, reason: String) -> Response {
        var headers = HTTPFields()
        headers[.contentType] = "application/json; charset=utf-8"
        // Hand-assembled so the error path does not pull JSONEncoder into the
        // wasm binary; the wire shape stays `{"error":true,"reason":...}`,
        // matching the swift-http-server host.
        let body = Response.Body(
            string: #"{"error":true,"reason":""# + escapeJSONString(reason) + #""}"#
        )
        return Response(status: status, headers: headers, body: body)
    }

    private static func escapeJSONString(_ value: String) -> String {
        var escaped = ""
        escaped.reserveCapacity(value.count)
        for scalar in value.unicodeScalars {
            switch scalar {
            case "\"":
                escaped += "\\\""
            case "\\":
                escaped += "\\\\"
            case "\n":
                escaped += "\\n"
            case "\r":
                escaped += "\\r"
            case "\t":
                escaped += "\\t"
            case let scalar where scalar.value < 0x20:
                let hex = String(scalar.value, radix: 16, uppercase: false)
                escaped += "\\u00" + (hex.count == 1 ? "0" + hex : hex)
            default:
                escaped.unicodeScalars.append(scalar)
            }
        }
        return escaped
    }
}

/// The end of the middleware chain: run the matched route or 404.
private final class CloudflarePageRouteResponder: Responder {
    let match: RouteMatch?

    init(match: RouteMatch?) {
        self.match = match
    }

    func respond(to request: Request) async throws -> Response {
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
private final class CloudflarePageErrorResponder: Responder {
    let next: any Responder
    let logger: Logger

    init(next: any Responder, logger: Logger) {
        self.next = next
        self.logger = logger
    }

    func respond(to request: Request) async throws -> Response {
        do {
            return try await next.respond(to: request)
        } catch let abort as Abort {
            return CloudflarePageServer.errorResponse(
                status: abort.status,
                reason: abort.reason ?? abort.status.reasonPhrase
            )
        } catch {
            #if !hasFeature(Embedded)
            if let decodingError = error as? DecodingError {
                logger.debug("Request decoding failed: \(HostErrorText.of(decodingError))")
                return CloudflarePageServer.errorResponse(status: .badRequest, reason: "Request payload could not be decoded")
            }
            #endif
            logger.error("Unhandled route error: \(HostErrorText.of(error))")
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

private struct CollectingBodyWriter: BodyWriter {
    private let chunks = CollectingBodyChunks()

    func write(_ bytes: [UInt8]) async throws {
        await chunks.append(bytes)
    }

    func collected() async -> [UInt8] {
        await chunks.all()
    }
}
