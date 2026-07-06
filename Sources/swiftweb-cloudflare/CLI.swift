import Foundation

/// Installs the Cloudflare deploy boundary into a SwiftWeb app package:
///
///     swiftweb-cloudflare install --app MyApp [--template new]
///         [--path <appPackageDir>] [--swift-web-cloudflare <path>]
///
/// Writes `deploy/cloudflare/` (worker: routing + per-identity DO) and
/// `deploy/wasm/` (the Durable Object wasm package + build.sh) from the
/// bundled templates, substituting `{{app.*}}` placeholders.
@main
struct SwiftWebCloudflareCLI {
    static func main() throws {
        var arguments = Array(CommandLine.arguments.dropFirst())
        guard arguments.first == "install" else {
            print("usage: swiftweb-cloudflare install --app <AppTypeName> [--template new] [--path <dir>] [--swift-web-cloudflare <path>]")
            exit(arguments.first == nil ? 1 : 64)
        }
        arguments.removeFirst()

        var appName: String?
        var template = "new"
        var appPath = FileManager.default.currentDirectoryPath
        var adapterPath = ("~/Desktop/swift-web-cloudflare" as NSString).expandingTildeInPath

        var iterator = arguments.makeIterator()
        while let argument = iterator.next() {
            switch argument {
            case "--app":
                appName = iterator.next()
            case "--template":
                template = iterator.next() ?? template
            case "--path":
                appPath = iterator.next() ?? appPath
            case "--swift-web-cloudflare":
                if let value = iterator.next() {
                    adapterPath = (value as NSString).expandingTildeInPath
                }
            default:
                throw CLIError.unknownArgument(argument)
            }
        }
        guard let appName else {
            throw CLIError.missingApp
        }

        let installer = DeployBoundaryInstaller(
            appName: appName,
            template: template,
            appDirectory: URL(fileURLWithPath: appPath, isDirectory: true),
            adapterDirectory: URL(fileURLWithPath: adapterPath, isDirectory: true)
        )
        try installer.run()
    }
}

enum CLIError: Error, CustomStringConvertible {
    case missingApp
    case unknownArgument(String)
    case templateNotFound(String)

    var description: String {
        switch self {
        case .missingApp:
            "--app <AppTypeName> is required"
        case .unknownArgument(let argument):
            "unknown argument: \(argument)"
        case .templateNotFound(let template):
            "template not found: \(template)"
        }
    }
}

struct DeployBoundaryInstaller {
    let appName: String
    let template: String
    let appDirectory: URL
    let adapterDirectory: URL

    private var substitutions: [String: String] {
        [
            "{{app.name}}": appName,
            "{{app.packageName}}": appName,
            "{{app.kebabName}}": Self.kebabCase(appName),
            "{{app.relativePath}}": "../..",
            "{{swiftWebCloudflare.relativePath}}": adapterDirectory.path,
        ]
    }

    func run() throws {
        guard let templates = Bundle.module.url(forResource: "Templates", withExtension: nil) else {
            throw CLIError.templateNotFound("Templates bundle")
        }
        let deploySource = templates.appendingPathComponent("\(template)/deploy/cloudflare")
        guard FileManager.default.fileExists(atPath: deploySource.path) else {
            throw CLIError.templateNotFound(template)
        }

        let deployDirectory = appDirectory.appendingPathComponent("deploy", isDirectory: true)
        try copyTree(
            from: deploySource,
            to: deployDirectory.appendingPathComponent("cloudflare", isDirectory: true)
        )
        try copyTree(
            from: templates.appendingPathComponent("wasm-package"),
            to: deployDirectory.appendingPathComponent("wasm", isDirectory: true)
        )
        try makeExecutable(deployDirectory.appendingPathComponent("wasm/build.sh"))

        print("installed deploy/cloudflare and deploy/wasm for \(appName)")
        print("next: deploy/wasm/build.sh && cd deploy/cloudflare && npm install && npm run dev")
    }

    private func copyTree(from source: URL, to destination: URL) throws {
        let fileManager = FileManager.default
        try fileManager.createDirectory(at: destination, withIntermediateDirectories: true)
        let contents = try fileManager.contentsOfDirectory(at: source, includingPropertiesForKeys: [.isDirectoryKey])
        for item in contents {
            let target = destination.appendingPathComponent(item.lastPathComponent)
            var isDirectory: ObjCBool = false
            fileManager.fileExists(atPath: item.path, isDirectory: &isDirectory)
            if isDirectory.boolValue {
                try copyTree(from: item, to: target)
            } else {
                try writeSubstituted(from: item, to: target)
            }
        }
    }

    private func writeSubstituted(from source: URL, to destination: URL) throws {
        let data = try Data(contentsOf: source)
        guard var text = String(data: data, encoding: .utf8) else {
            try data.write(to: destination)
            return
        }
        for (placeholder, value) in substitutions {
            text = text.replacingOccurrences(of: placeholder, with: value)
        }
        try text.write(to: destination, atomically: true, encoding: .utf8)
    }

    private func makeExecutable(_ url: URL) throws {
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
    }

    static func kebabCase(_ value: String) -> String {
        var output = ""
        for character in value {
            if character.isUppercase {
                if !output.isEmpty {
                    output.append("-")
                }
                output.append(character.lowercased())
            } else {
                output.append(character)
            }
        }
        return output
    }
}
