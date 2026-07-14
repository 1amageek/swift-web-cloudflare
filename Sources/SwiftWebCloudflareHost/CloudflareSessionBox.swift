#if canImport(FoundationEssentials)
import FoundationEssentials
#elseif canImport(Foundation)
import Foundation
#endif
import SwiftWebCore

/// In-isolate session persistence for the Cloudflare host, mirroring the
/// swift-http-server host's `InMemorySessionStorage`.
///
/// Workers isolates are transient and per-PoP: a session written here does not
/// survive isolate recycling and is not shared across locations. Apps that
/// need durable sessions must keep their state in a durable store (Durable
/// Object storage, KV) instead of the cookie session.
final class CloudflareSessionStorage: Sendable {
    // Workers isolates are single-threaded; plain storage is race-free here
    // and, unlike Mutex, exists on the Embedded profile.
    nonisolated(unsafe) private var sessions: [String: [String: String]] = [:]

    func read(_ id: String) -> [String: String]? {
        sessions[id]
    }

    func write(_ id: String, values: [String: String]) {
        sessions[id] = values
    }

    func delete(_ id: String) {
        sessions[id] = nil
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

    nonisolated(unsafe) private var state: State
    private let storage: CloudflareSessionStorage
    let hasExistingSession: Bool

    init(cookieValue: String?, storage: CloudflareSessionStorage) {
        self.storage = storage
        if let cookieValue, let values = storage.read(cookieValue) {
            self.state = State(id: cookieValue, values: values)
            self.hasExistingSession = true
        } else {
            self.state = State()
            self.hasExistingSession = false
        }
    }

    var webSession: RequestSession {
        RequestSession(
            identifierReader: { self.state.id },
            valuesReader: { self.state.values },
            valueReader: { key in self.state.values[key] },
            valueWriter: { key, value in
                guard value != nil || self.state.id != nil || !self.state.values.isEmpty else {
                    return
                }
                self.state.values[key] = value
                self.state.modified = true
                self.state.destroyed = false
            },
            destroyHandler: {
                guard self.state.id != nil else {
                    self.state.values.removeAll()
                    self.state.modified = false
                    return
                }
                self.state.values.removeAll()
                self.state.destroyed = true
                self.state.modified = false
            }
        )
    }

    /// Persists session changes and appends the matching `Set-Cookie` header.
    func finalize(response: inout Response) {
        let action: (id: String, values: [String: String]?)?
        if state.destroyed, let id = state.id {
            action = (id, nil)
        } else if state.modified {
            let id = state.id ?? Self.generateID()
            state.id = id
            action = (id, state.values)
        } else {
            action = nil
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
                    isSecure: false,
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
                    isSecure: false,
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
