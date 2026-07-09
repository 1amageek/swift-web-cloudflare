#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif
import JavaScriptKit
import SwiftWebActors

/// Backs `@ActorStorage` grain state with Durable Object SQLite. State is one
/// row per actor ID in the DO's own storage, so it is colocated with the actor
/// and survives eviction/hibernation.
///
/// The bridge is synchronous (DO SQLite has a synchronous API), matching the
/// closure-free trampoline: Swift sets the per-DO `token`, the actor ID, and the
/// blob on JS globals, then calls the `swiftwebStorageLoad`/`Save` globals the
/// Worker host implements against `ctx.storage.sql`. The token disambiguates the
/// DO whose storage to use when several DOs share one isolate.
final class DurableObjectActorStateStore: WebActorPersistentStore {
    private let token: Double

    init(token: Double) {
        self.token = token
    }

    func load(actorID: String) async throws -> [String: Data]? {
        let global = JSObject.global
        global.__swiftwebStorageToken = .number(token)
        global.__swiftwebStorageActorID = .string(actorID)
        _ = global.swiftwebStorageLoad.function?()
        guard let blob = global.__swiftwebStorageResult.string, !blob.isEmpty else {
            return nil
        }
        let encoded = try JSONDecoder().decode([String: String].self, from: Data(blob.utf8))
        var values: [String: Data] = [:]
        for (key, base64) in encoded {
            guard let data = Data(base64Encoded: base64) else {
                throw CloudflareHostError.storageDecodeFailed(key)
            }
            values[key] = data
        }
        return values
    }

    func save(actorID: String, values: [String: Data]) async throws {
        var encoded: [String: String] = [:]
        for (key, data) in values {
            encoded[key] = data.base64EncodedString()
        }
        let blob = String(decoding: try JSONEncoder().encode(encoded), as: UTF8.self)
        let global = JSObject.global
        global.__swiftwebStorageToken = .number(token)
        global.__swiftwebStorageActorID = .string(actorID)
        global.__swiftwebStorageBlob = .string(blob)
        _ = global.swiftwebStorageSave.function?()
    }
}
