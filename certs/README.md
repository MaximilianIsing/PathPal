# Apple root certificate for webhook verification

To **verify** signed payloads (transactions or V2 notifications) from Apple:

1. Download **Apple Root CA - G3**: https://www.apple.com/certificateauthority/AppleRootCA-G3.cer  
2. Place it in the **project root** as `AppleRootCA-G3.cer` (e.g. as a secret file on your host so it’s available at runtime). Or set `APPLE_ROOT_CA_PATH` in `.env` to the full path.
3. In `.env` set:
   - **APPLE_BUNDLE_ID** – Your app’s bundle ID. In Xcode: app target → General → Bundle Identifier (e.g. `pathpal.us.Path-Pal`). Same in App Store Connect.
   - **APPLE_ENVIRONMENT** – Where the webhook payloads come from: `Production` (real App Store), `Sandbox` (TestFlight), or `Xcode` (running from Xcode with StoreKit testing).
   - **APPLE_APP_ID** – Required only for `Production`. The numeric Apple ID of your app in App Store Connect (e.g. `1234567890`). Find it: App Store Connect → your app → App Information, or from the app URL: `apps.apple.com/app/id**1234567890**`.

With this and the cert in place, the server verifies JWS and only then grants Pro.
