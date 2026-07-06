@preconcurrency import ActorRuntime
#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif
#if canImport(JavaScriptEventLoop)
import JavaScriptEventLoop
#endif
import JavaScriptKit
import SwiftWebActors
import SwiftWebCore
import Synchronization

/// The Durable Object entry point: hosts an app's `ActorGroup` actors on the
/// real `WebActorSystem`, driven by JavaScriptKit's event loop.
///
/// JS protocol (all strings; JS is a no-interpretation trampoline). The wasm
/// entry module exposes two exports that forward here (`start(_:)` and
/// `invoke(_:)`); envelopes cross as the `__swiftwebEnvelope` JS global so no
/// JS closures or manual memory management are involved:
/// - Swift → JS `swiftwebReady()` once lowering finished, or
///   `swiftwebFailed(message)` if it threw.
/// - JS sets `globalThis.__swiftwebEnvelope` and calls the invoke export;
///   the export reads it via `CloudflareActorHost.invokePendingEnvelope()`.
/// - Swift → JS `swiftwebComplete(callID, responseJSON)` per invocation, or
///   `swiftwebInvokeFailed(callID, message)` when dispatch threw.
public enum CloudflareActorHost {
    private struct State: Sendable {
        var system: WebActorSystem?
        var executorInstalled = false
        var sockets: [Int: WebSocketActorTransport] = [:]
    }

    private static let state = Mutex(State())
    private static let sessions = WebSocketSessionRouter()

    public static func start<Definition: App>(_ definitionType: Definition.Type) {
        let installExecutor = state.withLock { state in
            let first = !state.executorInstalled
            state.executorInstalled = true
            return first
        }
        if installExecutor {
            #if canImport(JavaScriptEventLoop)
            JavaScriptEventLoop.installGlobalExecutor()
            #endif
        }

        Task {
            do {
                let definition = Definition()
                let application = CloudflareWebApplication()
                application.securityConfiguration = definition.security
                let system = definition.actorSystem
                try await _SceneRenderer.make(
                    definition.body,
                    in: .root(application, actorSystem: system)
                )
                system.setTransport(sessions)
                state.withLock { $0.system = system }

                _ = JSObject.global.swiftwebReady.function?()
            } catch {
                _ = JSObject.global.swiftwebFailed.function?(
                    JSValue.string(String(describing: error))
                )
            }
        }
    }

    /// Reads the envelope JS placed in `globalThis.__swiftwebEnvelope` and
    /// dispatches it. Wasm entry modules forward their invoke export here.
    public static func invokePendingEnvelope() {
        guard let envelopeJSON = JSObject.global.__swiftwebEnvelope.string else {
            _ = JSObject.global.swiftwebInvokeFailed.function?(
                JSValue.string(""),
                JSValue.string("__swiftwebEnvelope must be a JSON string")
            )
            return
        }
        invoke(envelopeJSON)
    }

    public static func invoke(_ envelopeJSON: String) {
        Task {
            do {
                guard let system = state.withLock({ $0.system }) else {
                    throw CloudflareHostError.notReady
                }
                let envelope = try JSONDecoder().decode(
                    InvocationEnvelope.self,
                    from: Data(envelopeJSON.utf8)
                )
                let response = try await system.invoke(envelope: envelope)
                let responseJSON = String(
                    decoding: try JSONEncoder().encode(response),
                    as: UTF8.self
                )
                _ = JSObject.global.swiftwebComplete.function?(
                    JSValue.string(envelope.callID),
                    JSValue.string(responseJSON)
                )
            } catch {
                _ = JSObject.global.swiftwebInvokeFailed.function?(
                    JSValue.string(Self.callID(in: envelopeJSON) ?? ""),
                    JSValue.string(String(describing: error))
                )
            }
        }
    }

    // MARK: - WebSocket sessions
    //
    // JS drives these through exports after placing the socket ID (and frame)
    // in the __swiftwebSocketID/__swiftwebSocketFrame globals; Swift sends
    // frames back by calling the swiftwebSocketSend(id, text) JS global.

    public static func socketOpened() {
        guard let id = JSObject.global.__swiftwebSocketID.number.map(Int.init) else {
            return
        }
        let transport = WebSocketActorTransport { text in
            _ = JSObject.global.swiftwebSocketSend.function?(
                JSValue.number(Double(id)),
                JSValue.string(text)
            )
        }
        if let system = state.withLock({ $0.system }) {
            transport.bind(system)
        }
        transport.onInboundSender { peerID, transport in
            sessions.register(peerID, transport: transport)
        }
        state.withLock { $0.sockets[id] = transport }
    }

    public static func socketMessage() {
        guard let id = JSObject.global.__swiftwebSocketID.number.map(Int.init),
              let frame = JSObject.global.__swiftwebSocketFrame.string else {
            return
        }
        state.withLock { $0.sockets[id] }?.receive(frame)
    }

    public static func socketClosed() {
        guard let id = JSObject.global.__swiftwebSocketID.number.map(Int.init) else {
            return
        }
        let transport = state.withLock { $0.sockets.removeValue(forKey: id) }
        guard let transport else {
            return
        }
        sessions.unregister(transport: transport)
        transport.closed()
    }

    private static func callID(in envelopeJSON: String) -> String? {
        struct CallIDProbe: Decodable {
            let callID: String?
        }
        do {
            return try JSONDecoder().decode(CallIDProbe.self, from: Data(envelopeJSON.utf8)).callID
        } catch {
            return nil
        }
    }
}

enum CloudflareHostError: Error {
    case notReady
}
