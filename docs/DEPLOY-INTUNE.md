# Deploying the Asqav Shadow AI Capture extension via Microsoft Intune

Use the Chrome `ExtensionInstallForcelist` policy to push the Asqav Shadow AI
Capture extension to a managed Windows fleet through Microsoft Intune. The
official Google guidance for force-installing Chrome extensions through MDM is
at:

https://support.google.com/chrome/a/answer/12129062

Below is the Asqav-specific path through Intune.

## Prerequisites

- Asqav extension is published to the Chrome Web Store (or hosted privately
  via an `.crx` file plus an `update_url`). Until Asqav publishes a stable
  store listing, side-load the unpacked extension for pilot users and use this
  document to drive the rollout once the listing is live.
- You know the extension ID (32-character lowercase string from the store
  listing or from `chrome://extensions` in Developer mode after Load unpacked).
- Devices are enrolled in Intune and run Chrome 89+ (MV3 support).

## Step 1: Confirm the extension ID

1. Open `chrome://extensions` on a dev device with the unpacked extension
   loaded.
2. Note the 32-character ID under "Asqav Shadow AI Capture".

For the rest of this guide that ID is `AAAA...AAAA`. Replace with your real
value.

## Step 2: Create the Intune configuration profile

1. In the Microsoft Intune admin center go to Devices > Configuration
   profiles > Create profile.
2. Platform: Windows 10 and later. Profile type: Templates > Administrative
   Templates (or Settings catalog if you prefer).
3. Name the profile `Chrome - Asqav Shadow AI Capture force-install`.

## Step 3: Configure ExtensionInstallForcelist

In the Settings catalog, search for `ExtensionInstallForcelist` under
`Google > Google Chrome > Extensions`. Add the following entry to the list:

```
AAAA...AAAA;https://clients2.google.com/service/update2/crx
```

The format is `<extension_id>;<update_url>`. Use the Chrome Web Store update
URL above for store-listed extensions, or your own hosted update manifest URL
for private deployments.

## Step 4: Alternative - paste JSON snippet

If you prefer the JSON shape that Intune ingests through the Custom OMA-URI or
the Settings Catalog import:

```json
{
  "ExtensionInstallForcelist": [
    "AAAA...AAAA;https://clients2.google.com/service/update2/crx"
  ]
}
```

Push this through OMA-URI:

- OMA-URI:
  `./Device/Vendor/MSFT/Policy/Config/Chrome~Policy~googlechrome~Extensions/ExtensionInstallForcelist`
- Data type: String
- Value: the JSON above.

## Step 5: Assign and roll out

1. Assign the profile to the pilot Azure AD group.
2. Wait for the next device sync (`Settings > Accounts > Access work or
   school > Sync` on Windows).
3. Verify on a managed device: `chrome://extensions` shows the extension as
   "Installed by your administrator" and the toggle is disabled.

## Step 6: Configure the API key and agent ID

The force-install gives you the extension; configuration still requires the
API key and agent ID. Two options:

- Manually open the options page on each device (suitable only for tiny pilots).
- Bundle a `policy.json` keyed on `chrome.storage.managed` and ship via
  Intune. This requires extending the manifest with a `storage` schema; Asqav
  ships the schema in v0.2 (tracked separately).

For v0 pilots, expect manual options-page configuration. Document the steps
for end users in your help center.

comment hygiene clean
