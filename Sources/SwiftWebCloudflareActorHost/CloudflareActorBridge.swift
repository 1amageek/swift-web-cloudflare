import JavaScriptKit

struct CloudflareActorRuntimeIdentity: Sendable {
    let runtimeID: Int
    let renderingID: Int
}

struct CloudflareActorFrameInput: Sendable {
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

/// Owns the string-and-number ABI between an actor-only Swift/WASM module and
/// the generated Durable Object runtime.
enum CloudflareActorBridge {
    static var currentRuntimeID: Int? {
        integer(JSObject.global.__swiftWebRuntimeID.number)
    }

    static var currentRenderingID: Int? {
        integer(JSObject.global.__swiftWebRenderingID.number)
    }

    static var currentActorFrameCallID: String? {
        nonEmpty(JSObject.global.__swiftWebActorFrameCallID.string)
    }

    static func runtimeIdentity() throws -> CloudflareActorRuntimeIdentity {
        guard let runtimeID = currentRuntimeID else {
            throw CloudflareActorBridgeError.invalidValue("runtimeID")
        }
        guard let renderingID = currentRenderingID else {
            throw CloudflareActorBridgeError.invalidValue("renderingID")
        }
        return CloudflareActorRuntimeIdentity(
            runtimeID: runtimeID,
            renderingID: renderingID
        )
    }

    static func actorFrameInput() throws -> CloudflareActorFrameInput {
        guard let runtimeID = currentRuntimeID else {
            throw CloudflareActorBridgeError.invalidValue("runtimeID")
        }
        guard let callID = currentActorFrameCallID else {
            throw CloudflareActorBridgeError.invalidValue("actorFrameCallID")
        }
        guard let encodedFrame = JSObject.global.__swiftWebActorFrameBase64.string,
              let frame = CloudflareActorBase64.decode(encodedFrame) else {
            throw CloudflareActorBridgeError.invalidValue("actorFrame")
        }
        guard let peerID = nonEmpty(JSObject.global.__swiftWebActorPeerID.string) else {
            throw CloudflareActorBridgeError.invalidValue("actorPeerID")
        }
        return CloudflareActorFrameInput(
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

    static func startupCompleted(_ identity: CloudflareActorRuntimeIdentity) {
        _ = function(named: "swiftWebDidRender")?(
            Double(identity.runtimeID),
            Double(identity.renderingID)
        )
    }

    static func startupFailed(
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

    static func actorFrameCompleted(
        runtimeID: Int,
        callID: String,
        encodedFrame: [UInt8]?
    ) {
        _ = function(named: "swiftWebDidInvokeActorFrame")?(
            Double(runtimeID),
            callID,
            encodedFrame.map(CloudflareActorBase64.encode) ?? ""
        )
    }

    static func actorFrameFailed(runtimeID: Int, callID: String, message: String) {
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
