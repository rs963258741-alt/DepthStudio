# Depth Studio

Native iOS SwiftUI app for synchronizing freediving UDDF telemetry with action-camera video.

## Current project contents

- ATMOS UDDF XML parser (first supported watch format: ATMOS Mission2 export)
- Timeline offset synchronization model
- Linear depth/temperature interpolation and vertical speed
- SwiftUI telemetry HUD and video preview
- AVFoundation/Core Animation MP4 export draft

## Build

This project is generated with XcodeGen. On macOS with Xcode and XcodeGen installed:

```sh
xcodegen generate --spec project.yml
xcodebuild -project DepthStudio.xcodeproj -scheme DepthStudio -sdk iphoneos CODE_SIGNING_ALLOWED=NO build
```

Codemagic uses the same commands in `codemagic.yaml` on a cloud macOS M2 runner.

## Important status

This is an initial integration scaffold, not a release-ready app. The SwiftUI screens and AVFoundation exporter must be compiled and tested on an iOS SDK runner. MP4 export, device compatibility, orientation, HDR handling, and precise HUD timing still require validation. Unsigned build artifacts cannot be installed directly on a physical iPhone; TestFlight distribution requires Apple signing credentials and an eligible Apple Developer account.
