import Foundation

@main struct UpdateConfigurationTests {
    static func main() {
        let sampleKey = Data(repeating: 42, count: 32).base64EncodedString()
        let valid: [String: Any] = [
            "SUFeedURL": "https://updates.example.com/appcast.xml",
            "SUPublicEDKey": sampleKey,
            "SUEnableAutomaticChecks": true,
            "SUAllowsAutomaticUpdates": false,
        ]
        precondition(UpdateConfiguration.isValid(valid))
        for (field, value) in [
            ("SUFeedURL", "http://updates.example.com/appcast.xml"),
            ("SUFeedURL", "https://user:password@updates.example.com/appcast.xml"),
            ("SUFeedURL", "https://updates.example.com/appcast.xml#fragment"),
            ("SUFeedURL", "https://"),
            ("SUPublicEDKey", "not-base64"),
            ("SUPublicEDKey", Data(repeating: 42, count: 31).base64EncodedString()),
        ] {
            var config = valid
            config[field] = value
            precondition(!UpdateConfiguration.isValid(config), "Accepted invalid \(field)")
        }
        for field in valid.keys {
            var config = valid
            config.removeValue(forKey: field)
            precondition(!UpdateConfiguration.isValid(config), "Accepted missing \(field)")
        }
        var noChecks = valid
        noChecks["SUEnableAutomaticChecks"] = false
        precondition(!UpdateConfiguration.isValid(noChecks))
        var automaticInstall = valid
        automaticInstall["SUAllowsAutomaticUpdates"] = true
        precondition(!UpdateConfiguration.isValid(automaticInstall))
        print("Updater configuration tests passed")
    }
}
