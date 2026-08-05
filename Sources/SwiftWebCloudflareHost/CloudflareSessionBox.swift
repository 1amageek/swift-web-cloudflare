#if canImport(FoundationEssentials)
import FoundationEssentials
#elseif canImport(Foundation)
import Foundation
#endif
import SwiftWebCore
import Synchronization

/// In-isolate session persistence for the Cloudflare host, mirroring the
/// swift-http-server host's `InMemorySessionStorage`.
///
/// Workers isolates are transient and per-PoP: a session written here does not
/// survive isolate recycling and is not shared across locations. Apps that
/// need durable sessions must keep their state in a durable store (Durable
/// Object storage, KV) instead of the cookie session.
final class CloudflareSessionStorage: Sendable {
    private let sessions = Mutex<[String: [String: String]]>([:])

    func read(_ id: String) -> [String: String]? {
        sessions.withLock { $0[id] }
    }

    func write(_ id: String, values: [String: String]) {
        sessions.withLock { $0[id] = values }
    }

    func delete(_ id: String) {
        sessions.withLock { $0[id] = nil }
    }
}

/// One request's session: loads lazily from the cookie, creates a session only
/// when a value is written (reading never sets a cookie), and persists /
/// expires the cookie when the response is finalized. Mirrors the
/// swift-http-server host's session box so app behavior matches across hosts.
final class CloudflareSessionBox: Sendable {
    static let cookieName = "swiftweb-session"
    private static let cookieMaxAge = 60 * 60 * 24 * 7

    private struct State {
        var id: String?
        var values: [String: String] = [:]
        var modified = false
        var destroyed = false
    }

    private let state: Mutex<State>
    private let storage: CloudflareSessionStorage
    private let isSecure: Bool
    let hasExistingSession: Bool

    init(
        cookieValue: String?,
        storage: CloudflareSessionStorage,
        isSecure: Bool
    ) {
        self.storage = storage
        self.isSecure = isSecure
        if let cookieValue, let values = storage.read(cookieValue) {
            self.state = Mutex(State(id: cookieValue, values: values))
            self.hasExistingSession = true
        } else {
            self.state = Mutex(State())
            self.hasExistingSession = false
        }
    }

    var webSession: RequestSession {
        RequestSession(
            identifierReader: { self.state.withLock { $0.id } },
            valuesReader: { self.state.withLock { $0.values } },
            valueReader: { key in self.state.withLock { $0.values[key] } },
            valueWriter: { key, value in
                self.state.withLock { state in
                    guard value != nil || state.id != nil || !state.values.isEmpty else {
                        return
                    }
                    state.values[key] = value
                    state.modified = true
                    state.destroyed = false
                }
            },
            destroyHandler: {
                self.state.withLock { state in
                    guard state.id != nil else {
                        state.values.removeAll()
                        state.modified = false
                        return
                    }
                    state.values.removeAll()
                    state.destroyed = true
                    state.modified = false
                }
            }
        )
    }

    /// Persists session changes and appends the matching `Set-Cookie` header.
    func finalize(response: inout Response) {
        let action = state.withLock { state
            -> (id: String, values: [String: String]?)? in
            if state.destroyed, let id = state.id {
                return (id, nil)
            }
            guard state.modified else {
                return nil
            }
            let id = state.id ?? Self.generateID()
            state.id = id
            return (id, state.values)
        }
        guard let action else {
            return
        }
        if let values = action.values {
            storage.write(action.id, values: values)
            response.setCookie(
                Self.cookieName,
                CookieValue(
                    string: action.id,
                    maxAge: Self.cookieMaxAge,
                    path: "/",
                    isSecure: isSecure,
                    isHTTPOnly: true,
                    sameSite: .lax
                )
            )
        } else {
            storage.delete(action.id)
            response.setCookie(
                Self.cookieName,
                CookieValue(
                    string: "",
                    maxAge: 0,
                    path: "/",
                    isSecure: isSecure,
                    isHTTPOnly: true,
                    sameSite: .lax
                )
            )
        }
    }

    private static func generateID() -> String {
        var generator = SystemRandomNumberGenerator()
        let bytes = (0..<32).map { _ in UInt8.random(in: .min ... .max, using: &generator) }
        return Base64Coding.encode(bytes)
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
