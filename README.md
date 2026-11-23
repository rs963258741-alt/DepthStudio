# Depth Studio

Native iOS SwiftUI app for synchronizing freediving UDDF telemetry with action-camera video.

## Flat upload layout

All app and build files are placed in this directory so they can be selected together in GitHub's **Add file → Upload files** page. No project subfolder is required.

- `AtmosUDDFParser.swift` — ATMOS UDDF parser
- `ContentView.swift` — main SwiftUI screen and file import
- `DepthStudioApp.swift` — app entry point
- `DiveDataInterpolator.swift` — interpolation and vertical speed
- `DiveHUDOverlay.swift` — live telemetry HUD
- `DiveVideoExporter.swift` — AVFoundation/Core Animation export draft
- `DiveVideoPreview.swift` — video preview and HUD controls
- `TimelineSync.swift` — watch/video time alignment
- `project.yml` — XcodeGen project definition; explicitly references the eight root-level Swift files
- `codemagic.yaml` — Codemagic cloud build workflow

The repository's existing root `.gitignore` can remain as-is. The existing `.github/workflows` folder is separate GitHub automation and does not need to be uploaded with these app files.

## Build

On macOS with Xcode and XcodeGen installed:

```sh
xcodegen generate --spec project.yml
xcodebuild -project DepthStudio.xcodeproj -scheme DepthStudio -sdk iphoneos CODE_SIGNING_ALLOWED=NO build
```

Codemagic runs the same generation and build commands on a cloud macOS runner.

## Status and limitations

This is an initial integration scaffold, not a release-ready app. A successful Swift syntax parse is not the same as a full iOS SDK build. The app must still pass Codemagic's Xcode compilation and on-device tests. MP4 export, camera format compatibility, orientation, HDR handling, and timing accuracy still require validation. An unsigned `.app` cannot be installed directly on a physical iPhone; TestFlight distribution requires Apple signing credentials and an eligible Apple Developer account.

## Build fixes (2026-11-23)

- `DiveExportSettings.quality` is declared as `String`, matching AVFoundation export preset constants such as `AVAssetExportPresetHighestQuality`.
- The video file importer uses `UTType.mpeg4Movie` instead of the nonexistent `UTType.mpeg4`; QuickTime and general movie types are also accepted.
- All eight Swift source files remain at the repository root; `project.yml` explicitly lists those eight root-level files.

## Local validation performed

- Swift syntax parsing passed for all eight Swift files.
- The ATMOS Mission2 UDDF parser and timeline synchronization smoke test passed against the supplied 37-sample UDDF file.
- Depth interpolation, temperature interpolation, descent/ascent speed, and out-of-range checks passed.
- Both YAML files parsed successfully, and all eight `project.yml` source paths exist.
- These checks do not replace a full Xcode/iOS SDK build. The next Codemagic run is still required to verify compilation on Apple's iOS SDK.
