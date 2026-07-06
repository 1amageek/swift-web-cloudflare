@preconcurrency import ActorRuntime
#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif
import JavaScriptEventLoop
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
    }

    private static let state = Mutex(State())

    public static func start<Definition: App>(_ definitionType: Definition.Type) {
        let installExecutor = state.withLock { state in
            let first = !state.executorInstalled
            state.executorInstalled = true
            return first
        }
        if installExecutor {
            JavaScriptEventLoop.installGlobalExecutor()
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
