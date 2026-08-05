enum CloudflareHostError: Error {
    case invalidBridgeValue(String)
    case notReady
    case storageDecodeFailed(String)
}
