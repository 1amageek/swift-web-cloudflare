/// Error rendering for log messages; Embedded Swift has no reflection.
enum HostErrorText {
    static func of(_ error: any Error) -> String {
        #if hasFeature(Embedded)
        "error"
        #else
        String(describing: error)
        #endif
    }
}
