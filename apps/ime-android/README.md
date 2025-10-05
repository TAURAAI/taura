# Taura Android Keyboard (IME)

This module hosts the Android keyboard extension used by Taura. It exposes an `InputMethodService` that renders a Compose-powered suggestion strip, calls the Taura search backend, and inserts results back into the active editor.

## Project layout

```
apps/ime-android/
├─ app/                   # Android application module (Gradle)
├─ build.gradle.kts       # Root Gradle build script
├─ gradle/                # Wrapper configuration
├─ gradle.properties
├─ gradlew / gradlew.bat
└─ settings.gradle.kts
```

## Development setup

1. Ensure you have Android Studio Hedgehog (or newer), the Android SDK 34 platform, and the latest command line tools installed.
2. Generate the Gradle wrapper JAR if it is missing by running `gradle wrapper --gradle-version 8.7` once (requires the Gradle CLI) or by copying `gradle-wrapper.jar` from another Gradle 8.7 installation into `gradle/wrapper/`.
3. From this directory, run `./gradlew tasks` (or `gradlew.bat` on Windows) once to download the remaining wrapper dependencies and verify the setup.
4. Open `apps/ime-android` in Android Studio. The IDE will import the Gradle project and index sources.
5. Configure the keyboard from **Settings → System → Languages & input → On-screen keyboard → Manage keyboards** and enable **Taura Keyboard**.
6. Launch the **Keyboard Settings** activity (application icon) to provide the Taura API base URL, user ID, and auth token before testing suggestions.

## Local backend expectations

The keyboard searches against the Go API gateway described in `AGENTS.md`. By default the client targets `http://10.0.2.2:8080` (Android emulator loopback). Adjust the base URL inside the app settings when using a physical device or different port.

## Next steps

* Hook the settings screen up to OAuth flow once the companion app provisions tokens.
* Implement thumbnail rendering inside the suggestion strip (requires rich content support).
* Add instrumentation tests covering query debounce and suggestion rendering.
