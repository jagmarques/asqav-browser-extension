# Deploying the Asqav Shadow AI Capture extension via Microsoft Intune

Use the Chrome `ExtensionInstallForcelist` policy to push the Asqav Shadow AI
Capture extension to a managed Windows fleet through Microsoft Intune. The
official Google guidance for force-installing Chrome extensions through MDM is
at:

https://support.google.com/chrome/a/answer/12129062

The canonical Chrome enterprise reference for the `chrome.storage.managed`
contract used in Step 6 is:

https://support.google.com/chrome/a/answer/9867568

Below is the Asqav-specific path through Intune.

## Permission model change in v0.1.0

The Asqav extension manifest declares `optional_host_permissions` for the 28
supported AI tool domains. This is a runtime permission model: the extension
loads without any host permission and the operator (or the MDM policy in
Step 6) requests access at runtime. Two consequences:

- The Chrome Web Store install screen does not show a broad "read and change
  all your data on N sites" warning.
- Force-installing the extension alone does NOT enable detection. You must
  also push the `chrome.storage.managed` policy from Step 6 so the extension
  auto-grants the AI host permissions on cold start without user prompts.

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

## Step 4: Alternative, paste JSON snippet

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

## Step 6: Auto-enable detection on managed devices

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
without prompting the user. The result: a freshly enrolled device begins
emitting receipts on the first AI tool navigation, with no helpdesk ticket.

There are two delivery channels for the managed policy on Windows.

### Option A: Intune Settings Catalog (recommended)

1. In the Intune admin center go to Devices > Configuration profiles > Create
   profile > Platform: Windows 10 and later > Profile type: Settings catalog.
2. Add the setting `Configure the list of force-installed apps and extensions`
   under `Google Chrome > Extensions` (this is the same setting from Step 3).
3. Add a second setting: `Configure managed storage settings for the
   extension` (search for `3rdparty.extensions.<extension-id>.policy`).
4. Paste the following JSON, replacing `AAAA...AAAA` with your extension ID
   and `<your-api-key>` with the API key issued by your Asqav admin:

```json
{
  "mdmAutoEnable": { "Value": true },
  "mdmApiKey": { "Value": "<your-api-key>" },
  "mdmApiEndpoint": { "Value": "https://api.asqav.com/api/v1/agents" },
  "mdmManagedHosts": {
    "Value": [
      "https://chat.openai.com/*",
      "https://chatgpt.com/*",
      "https://claude.ai/*",
      "https://gemini.google.com/*",
      "https://copilot.microsoft.com/*"
    ]
  }
}
```

Assign the profile to the same pilot Azure AD group as the force-install
profile.

### Option B: Custom Configuration Profile pushing a Chrome policies JSON

If your fleet does not surface the managed-extension setting in the Settings
Catalog you can ship the policy as a JSON file under the Chrome managed
policies path:

`%ProgramFiles%\Google\Policies\managed\asqav-<extension-id>.json`

with the same JSON body as Option A. Wrap the file deployment in an Intune
Win32 app (or use a PowerShell script via Devices > Scripts) that drops the
JSON during the next sync.

## Step 7: Verify on a managed Windows device

1. Force a sync.
2. Open `chrome://policy` and confirm the four `mdm*` keys appear under
   "Extension policies" for your Asqav extension ID, with the right values.
3. Open the Asqav options page (Extensions > Asqav Shadow AI Capture >
   Details > Extension options). The "AI tool detection" section should show
   "Detection enabled. Permissions granted." with no manual click required.
4. Navigate to chat.openai.com. Within seconds you should see a receipt land
   in the Asqav dashboard for your agent ID.

## Rollback

To disable auto-detection without uninstalling the extension, set
`mdmAutoEnable` to false in the managed-storage policy and let Chrome sync
the change. The extension stops requesting permissions on startup; existing
grants persist until the operator clicks "Disable Detection" on the options
page or until you also remove the `mdmManagedHosts` entries via the Chrome
`ExtensionSettings` policy.

comment hygiene clean
