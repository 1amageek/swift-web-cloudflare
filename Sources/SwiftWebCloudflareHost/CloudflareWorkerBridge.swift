import JavaScriptKit
@_spi(Hosting) import SwiftWebCore

struct CloudflareRenderingIdentity: Sendable {
    let runtimeID: Int
    let renderingID: Int
    let storageToken: Double?
}

struct CloudflareActorFrameInvocation: Sendable {
    let runtimeID: Int
    let callID: String
    let encodedFrame: [UInt8]
    let principalID: String?
    let sessionID: String?
    let tenantID: String?
    let remoteAddress: String?
    let peerID: String
    let hostedActorIdentity: String?
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

    static var currentActorFrameCallID: String? {
        nonEmpty(JSObject.global.__swiftWebActorFrameCallID.string)
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

    static func actorFrameInvocation() throws -> CloudflareActorFrameInvocation {
        guard let runtimeID = currentRuntimeID else {
            throw CloudflareHostError.invalidBridgeValue("runtimeID")
        }
        guard let callID = currentActorFrameCallID else {
            throw CloudflareHostError.invalidBridgeValue("actorFrameCallID")
        }
        guard let encodedFrame = JSObject.global.__swiftWebActorFrameBase64.string,
              let frame = Base64Coding.decode(encodedFrame) else {
            throw CloudflareHostError.invalidBridgeValue("actorFrame")
        }
        guard let peerID = nonEmpty(JSObject.global.__swiftWebActorPeerID.string) else {
            throw CloudflareHostError.invalidBridgeValue("actorPeerID")
        }
        return CloudflareActorFrameInvocation(
            runtimeID: runtimeID,
            callID: callID,
            encodedFrame: frame,
            principalID: nonEmpty(JSObject.global.__swiftWebActorPrincipalID.string),
            sessionID: nonEmpty(JSObject.global.__swiftWebActorSessionID.string),
            tenantID: nonEmpty(JSObject.global.__swiftWebActorTenantID.string),
            remoteAddress: nonEmpty(JSObject.global.__swiftWebActorRemoteAddress.string),
            peerID: peerID,
            hostedActorIdentity: nonEmpty(
                JSObject.global.__swiftWebHostedActorIdentity.string
            )
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

    static func actorFrameInvocationCompleted(
        runtimeID: Int,
        callID: String,
        encodedFrame: [UInt8]?
    ) {
        _ = function(named: "swiftWebDidInvokeActorFrame")?(
            Double(runtimeID),
            callID,
            encodedFrame.map(Base64Coding.encode) ?? ""
        )
    }

    static func actorFrameInvocationFailed(runtimeID: Int, callID: String, message: String) {
        _ = function(named: "swiftWebActorFrameInvocationFailed")?(
            Double(runtimeID),
            callID,
            message
        )
    }

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
