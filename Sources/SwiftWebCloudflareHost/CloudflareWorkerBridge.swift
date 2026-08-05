#if SWIFTWEB_ACTORS
#if canImport(FoundationEssentials)
import FoundationEssentials
#elseif canImport(Foundation)
import Foundation
#endif
#endif
import JavaScriptKit

struct CloudflareRenderingIdentity: Sendable {
    let runtimeID: Int
    let renderingID: Int
    let storageToken: Double?
}

struct CloudflareActorInvocation: Sendable {
    let runtimeID: Int
    let envelopeJSON: String
    let principal: String?
}

struct CloudflareSocketInput: Sendable {
    let runtimeID: Int
    let socketID: Int
    let principal: String?
}

struct CloudflareSocketMessage: Sendable {
    let runtimeID: Int
    let socketID: Int
    let frame: String
}

/// The string-and-number ABI between the generated Worker and Swift/WASM.
enum CloudflareWorkerBridge {
    static var currentRuntimeID: Int? {
        integer(JSObject.global.__swiftWebRuntimeID.number)
    }

    static var currentRenderingID: Int? {
        integer(JSObject.global.__swiftWebRenderingID.number)
    }

    static var currentRequestCallID: String? {
        nonEmpty(JSObject.global.__swiftWebRequestCallID.string)
    }

    static func renderingIdentity() throws -> CloudflareRenderingIdentity {
        guard let runtimeID = currentRuntimeID else {
            throw CloudflareHostError.invalidBridgeValue("runtimeID")
        }
        guard let renderingID = currentRenderingID else {
            throw CloudflareHostError.invalidBridgeValue("renderingID")
        }
        let storageToken = JSObject.global.__swiftWebStorageToken.number.flatMap {
            $0 > 0 && $0.isFinite ? $0 : nil
        }
        return CloudflareRenderingIdentity(
            runtimeID: runtimeID,
            renderingID: renderingID,
            storageToken: storageToken
        )
    }

    static func pageRequest() throws -> CloudflarePageRequest {
        guard let runtimeID = currentRuntimeID else {
            throw CloudflareHostError.invalidBridgeValue("runtimeID")
        }
        guard let callID = currentRequestCallID else {
            throw CloudflareHostError.invalidBridgeValue("requestCallID")
        }
        return CloudflarePageRequest(
            runtimeID: runtimeID,
            callID: callID,
            method: JSObject.global.__swiftWebRequestMethod.string ?? "GET",
            path: JSObject.global.__swiftWebRequestPath.string ?? "/",
            search: nonEmpty(JSObject.global.__swiftWebRequestSearch.string),
            scheme: nonEmpty(JSObject.global.__swiftWebRequestScheme.string),
            host: nonEmpty(JSObject.global.__swiftWebRequestHost.string),
            headers: CloudflarePageWire.decodeHeaders(
                JSObject.global.__swiftWebRequestHeaders.string ?? ""
            ),
            bodyBase64: nonEmpty(JSObject.global.__swiftWebRequestBodyBase64.string)
        )
    }

    static func actorInvocation() throws -> CloudflareActorInvocation {
        guard let runtimeID = currentRuntimeID else {
            throw CloudflareHostError.invalidBridgeValue("runtimeID")
        }
        guard let envelopeJSON = JSObject.global.__swiftWebActorEnvelope.string else {
            throw CloudflareHostError.invalidBridgeValue("actorEnvelope")
        }
        return CloudflareActorInvocation(
            runtimeID: runtimeID,
            envelopeJSON: envelopeJSON,
            principal: nonEmpty(JSObject.global.__swiftWebPrincipal.string)
        )
    }

    static func socketInput() throws -> CloudflareSocketInput {
        guard let runtimeID = currentRuntimeID else {
            throw CloudflareHostError.invalidBridgeValue("runtimeID")
        }
        guard let socketID = integer(JSObject.global.__swiftWebSocketID.number) else {
            throw CloudflareHostError.invalidBridgeValue("socketID")
        }
        return CloudflareSocketInput(
            runtimeID: runtimeID,
            socketID: socketID,
            principal: nonEmpty(JSObject.global.__swiftWebSocketPrincipal.string)
        )
    }

    static func socketMessage() throws -> CloudflareSocketMessage {
        let input = try socketInput()
        guard let frame = JSObject.global.__swiftWebSocketFrame.string else {
            throw CloudflareHostError.invalidBridgeValue("socketFrame")
        }
        return CloudflareSocketMessage(
            runtimeID: input.runtimeID,
            socketID: input.socketID,
            frame: frame
        )
    }

    static func renderingCompleted(_ identity: CloudflareRenderingIdentity) {
        _ = function(named: "swiftWebDidRender")?(
            Double(identity.runtimeID),
            Double(identity.renderingID)
        )
    }

    static func renderingFailed(
        runtimeID: Int,
        renderingID: Int,
        message: String
    ) {
        _ = function(named: "swiftWebRenderingFailed")?(
            Double(runtimeID),
            Double(renderingID),
            message
        )
    }

    static func requestCompleted(
        runtimeID: Int,
        callID: String,
        response: CloudflarePageResponse
    ) {
        _ = function(named: "swiftWebDidRespond")?(
            Double(runtimeID),
            callID,
            Double(response.status),
            response.headersWire,
            response.bodyBase64
        )
    }

    static func requestFailed(runtimeID: Int, callID: String, message: String) {
        _ = function(named: "swiftWebResponseFailed")?(
            Double(runtimeID),
            callID,
            message
        )
    }

    static func actorInvocationCompleted(
        runtimeID: Int,
        callID: String,
        responseJSON: String
    ) {
        _ = function(named: "swiftWebDidInvokeActor")?(
            Double(runtimeID),
            callID,
            responseJSON
        )
    }

    static func actorInvocationDenied(runtimeID: Int, callID: String, reason: String) {
        _ = function(named: "swiftWebActorInvocationDenied")?(
            Double(runtimeID),
            callID,
            reason
        )
    }

    static func actorInvocationFailed(runtimeID: Int, callID: String, message: String) {
        _ = function(named: "swiftWebActorInvocationFailed")?(
            Double(runtimeID),
            callID,
            message
        )
    }

    static func sendSocketFrame(runtimeID: Int, socketID: Int, frame: String) {
        _ = function(named: "swiftWebSendSocketFrame")?(
            Double(runtimeID),
            Double(socketID),
            frame
        )
    }

    #if SWIFTWEB_ACTORS
    static func callID(in envelopeJSON: String) -> String? {
        struct CallIDProbe: Decodable {
            let callID: String?
        }
        do {
            return try JSONDecoder().decode(
                CallIDProbe.self,
                from: Data(envelopeJSON.utf8)
            ).callID
        } catch {
            return nil
        }
    }
    #endif

    private static func integer(_ value: Double?) -> Int? {
        guard let value,
              value.isFinite,
              value.rounded(.towardZero) == value,
              value >= Double(Int.min),
              value <= Double(Int.max) else {
            return nil
        }
        return Int(value)
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let value, !value.isEmpty else {
            return nil
        }
        return value
    }

    private static func function(named name: String) -> JSObject? {
        let value: JSValue = JSObject.global[name]
        return value.function
    }
}
