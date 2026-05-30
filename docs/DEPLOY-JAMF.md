# Deploying the Asqav Shadow AI Capture extension via JAMF Pro

Use a JAMF Pro Chrome configuration profile to force-install the Asqav Shadow
AI Capture extension on a managed macOS Chromium fleet. The canonical JAMF
guidance for configuring Chrome via a configuration profile is at:

https://learn.jamf.com/en-US/bundle/jamf-pro-documentation-current/page/Computer_Configuration_Profiles.html

Google's vendor guidance for the underlying policy:

https://support.google.com/chrome/a/answer/12129062

The canonical Chrome enterprise reference for the `chrome.storage.managed`
contract used in Step 4 is:

https://support.google.com/chrome/a/answer/9867568

## Permission model change in v0.1.0

The Asqav extension manifest declares `optional_host_permissions` for the 28
supported AI tool domains. This is a runtime permission model: the extension
loads without any host permission and the operator (or the MDM policy in
Step 4) requests access at runtime. Two consequences:

- The Chrome Web Store install screen does not show a broad "read and change
  all your data on N sites" warning.
- Force-installing the extension alone does NOT enable detection. You must
  also push the `chrome.storage.managed` policy from Step 4 so the extension
  auto-grants the AI host permissions on cold start without user prompts.

## Prerequisites

- macOS devices enrolled in JAMF Pro.
- Chrome 89+ installed (MV3 support).
- Extension ID from `chrome://extensions` on a dev device.

## Step 1: Build the Chrome force-install plist

Create `com.google.Chrome.plist` with this content (replace the 32-character
ID with the real extension ID):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>ExtensionInstallForcelist</key>
    <array>
      <string>AAAA...AAAA;https://clients2.google.com/service/update2/crx</string>
    </array>
  </dict>
</plist>
```

## Step 2: Upload to JAMF Pro

1. JAMF Pro > Computers > Configuration Profiles > New.
2. General tab: name `Chrome - Asqav Shadow AI Capture force-install`.
   Distribution Method: Install Automatically. Level: Computer Level.
3. Application & Custom Settings > Upload.
4. Preference Domain: `com.google.Chrome`.
5. Upload the plist from Step 1.
6. Scope tab: target the pilot computer group.
7. Save.

## Step 3: Verify on a managed Mac

1. Force a check-in: `sudo jamf policy`.
2. Open Chrome, go to `chrome://policy`. Confirm
   `ExtensionInstallForcelist` shows the Asqav extension ID.
3. Open `chrome://extensions`. The Asqav extension is listed and marked
   "Installed by your administrator".

## Step 4: Auto-enable detection on managed devices

The v0.1.0 extension reads four keys from `chrome.storage.managed` on cold
start (handled by the `chrome.runtime.onInstalled` and
`chrome.runtime.onStartup` hooks):

| Key                | Type    | Effect when set                                                                                              |
| ------------------ | ------- | ------------------------------------------------------------------------------------------------------------ |
| `mdmAutoEnable`    | boolean | Master switch. When true, the next three keys are applied.                                                   |
| `mdmApiKey`        | string  | Written to `chrome.storage.session.apiKey` so receipts can be signed without the user visiting Options.      |
| `mdmApiEndpoint`   | string  | Override of the default signer base URL `https://api.asqav.com/api/v1/agents`. Use for private Asqav cloud.  |
| `mdmManagedHosts`  | array   | List of host patterns to auto-grant. Defaults to the bundled 28-domain AI seed list when absent.             |

Chrome auto-grants permission requests that originate from MDM-pushed policy
without prompting the user. The result: a freshly enrolled Mac begins
emitting receipts on the first AI tool navigation, with no helpdesk ticket.

### Configuration profile

1. JAMF Pro > Computers > Configuration Profiles > New (or extend the
   force-install profile from Step 2).
2. Application & Custom Settings > Custom Settings > Upload.
3. Preference Domain: `com.google.Chrome.extensions.AAAA...AAAA` (replace the
   32-character ID with your extension ID). Chrome maps this domain to
   `chrome.storage.managed` for that extension.
4. Upload the following plist (replace `<your-api-key>` and adjust the host
   list to taste):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>mdmAutoEnable</key>
    <true/>
    <key>mdmApiKey</key>
    <string>&lt;your-api-key&gt;</string>
    <key>mdmApiEndpoint</key>
    <string>https://api.asqav.com/api/v1/agents</string>
    <key>mdmManagedHosts</key>
    <array>
      <string>https://chat.openai.com/*</string>
      <string>https://chatgpt.com/*</string>
      <string>https://claude.ai/*</string>
      <string>https://gemini.google.com/*</string>
      <string>https://copilot.microsoft.com/*</string>
    </array>
  </dict>
</plist>
```

5. Scope tab: target the same pilot computer group as the force-install
   profile.
6. Save.

## Step 5: Verify on a managed Mac

1. Force a check-in: `sudo jamf policy`.
2. Open `chrome://policy` and confirm the four `mdm*` keys appear under
   "Extension policies" for your Asqav extension ID, with the right values.
3. Open the Asqav options page (Extensions > Asqav Shadow AI Capture >
   Details > Extension options). The "AI tool detection" section should show
   "Detection enabled. Permissions granted." with no manual click required.
4. Navigate to chat.openai.com. Within seconds you should see a receipt land
   in the Asqav dashboard for your agent ID.

## Rollback

To disable auto-detection without uninstalling the extension, set
`mdmAutoEnable` to false in the managed-storage plist and let JAMF push the
change. The extension stops requesting permissions on startup; existing
grants persist until the operator clicks "Disable Detection" on the options
page or until you also remove the managed-host plist entries.
