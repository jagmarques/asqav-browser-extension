# Deploying the Asqav Shadow AI Capture extension via JAMF Pro

Use a JAMF Pro Chrome configuration profile to force-install the Asqav Shadow
AI Capture extension on a managed macOS Chromium fleet. The canonical JAMF
guidance for configuring Chrome via a configuration profile is at:

https://learn.jamf.com/en-US/bundle/jamf-pro-documentation-current/page/Computer_Configuration_Profiles.html

Google's vendor guidance for the underlying policy:

https://support.google.com/chrome/a/answer/12129062

## Prerequisites

- macOS devices enrolled in JAMF Pro.
- Chrome 89+ installed (MV3 support).
- Extension ID from `chrome://extensions` on a dev device.

## Step 1: Build the Chrome plist

Create `com.google.Chrome.plist` with this content (replace the 32-character ID
with the real extension ID):

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

## Step 4: Configure the API key and agent ID

v0 requires a manual visit to the options page on each device. For larger
rollouts, ship a `chrome.storage.managed` policy via the same JAMF profile
once Asqav exposes the managed schema in v0.2.

## Safari Blueprint hook (future v0.5)

JAMF Pro 11.5+ supports the Safari Web Extensions blueprint for declarative
deployment of native Safari extensions. The Asqav Safari v0.5 build will ship
as a Safari Web Extension and reuse the same receipt-emitting logic. To
prepare:

1. Reserve a JAMF blueprint slot named
   `Safari - Asqav Shadow AI Capture force-install`.
2. Plan to associate the Asqav Safari extension App Store bundle ID once
   published.
3. Until v0.5 ships, JAMF customers cover Safari users via the existing
   network-proxy `capture_topology="network_proxy"` path documented in the
   Asqav shadow-AI runbook.

comment hygiene clean
