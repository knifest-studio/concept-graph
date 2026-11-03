import Foundation

// Only a real HTTPS feed and Ed25519 public key may enable the updater.
enum UpdateConfiguration {
    static func isValid(_ values: [String: Any]) -> Bool {
        guard let feed = values["SUFeedURL"] as? String,
              let url = URLComponents(string: feed), url.scheme?.lowercased() == "https",
              let host = url.host, !host.isEmpty, url.user == nil, url.password == nil,
              url.fragment == nil,
              let publicKey = values["SUPublicEDKey"] as? String,
              let decoded = Data(base64Encoded: publicKey), decoded.count == 32,
              let automaticChecks = values["SUEnableAutomaticChecks"] as? Bool, automaticChecks,
              let automaticInstallation = values["SUAllowsAutomaticUpdates"] as? Bool, !automaticInstallation
        else { return false }
        return true
    }
}
