enum CloudflareActorBridgeError: Error {
    case invalidValue(String)
    case frameTooLarge(Int)
}
