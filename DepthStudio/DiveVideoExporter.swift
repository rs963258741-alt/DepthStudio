import Foundation
import AVFoundation
import UIKit
import QuartzCore

/// Export settings for the first MP4 renderer.
/// Overlay placement is intentionally expressed as fractions of the final video size.
struct DiveExportSettings {
    // AVAssetExportPresetHighestQuality is a preset-name String, not an AVAssetExportPreset type.
    var quality: String = AVAssetExportPresetHighestQuality
    var includeTemperature = true
    var includeDepthProfile = true
    var overlayOpacity: Float = 0.88
    var overlayScale: CGFloat = 1.0
    var overlayBottomInset: CGFloat = 0.045
    var outputFileType: AVFileType = .mp4
}

/// Errors surfaced to the UI so unsupported files do not silently produce empty exports.
enum DiveExportError: LocalizedError {
    case noVideoTrack
    case invalidDuration
    case invalidSamples
    case invalidSync
    case noSamplesInVideoRange
    case invalidSettings
    case invalidOutputURL
    case outputWouldOverwriteSource
    case invalidRenderSize
    case cannotCreateExportSession
    case unsupportedOutputType
    case exportFailed(String)

    var errorDescription: String? {
        switch self {
        case .noVideoTrack:
            return "找不到可輸出的影片影像軌。"
        case .invalidDuration:
            return "影片長度無效。"
        case .invalidSamples:
            return "手錶數據不足或包含無效資料，無法建立 HUD。"
        case .invalidSync:
            return "影片與手錶的同步錨點無效。"
        case .noSamplesInVideoRange:
            return "目前的同步偏移沒有任何手錶數據落在影片時間範圍內。"
        case .invalidSettings:
            return "影片輸出設定無效，請檢查品質、透明度、大小與位置。"
        case .invalidOutputURL:
            return "輸出位置無效，請選擇有效的本機檔案位置。"
        case .outputWouldOverwriteSource:
            return "輸出檔案不能與原始影片使用相同位置。"
        case .invalidRenderSize:
            return "影片尺寸或旋轉資訊無效，無法建立輸出畫面。"
        case .cannotCreateExportSession:
            return "無法建立影片輸出工作。"
        case .unsupportedOutputType:
            return "目前輸出格式不受支援，請選擇 MP4。"
        case .exportFailed(let message):
            return "影片輸出失敗：\(message)"
        }
    }
}

/// Creates a finished MP4 with an animated depth HUD using AVFoundation + Core Animation.
/// This file is an iOS implementation draft; integrate into the Xcode target and test on device.
final class DiveVideoExporter {
    func export(
        videoURL: URL,
        samples: [DiveSample],
        sync: TimelineSync,
        settings: DiveExportSettings = DiveExportSettings(),
        outputURL: URL,
        completion: @escaping (Result<URL, Error>) -> Void
    ) {
        Task {
            do {
                try validate(settings: settings)

                guard videoURL.isFileURL, outputURL.isFileURL else {
                    throw DiveExportError.invalidOutputURL
                }
                guard videoURL.standardizedFileURL != outputURL.standardizedFileURL else {
                    throw DiveExportError.outputWouldOverwriteSource
                }

                let asset = AVURLAsset(url: videoURL)
                let videoTracks = try await asset.loadTracks(withMediaType: .video)
                guard let sourceVideoTrack = videoTracks.first else {
                    throw DiveExportError.noVideoTrack
                }

                let duration = try await asset.load(.duration)
                guard duration.seconds.isFinite, duration.seconds > 0 else {
                    throw DiveExportError.invalidDuration
                }

                let naturalSize = try await sourceVideoTrack.load(.naturalSize)
                let preferredTransform = try await sourceVideoTrack.load(.preferredTransform)
                let sourceFrameDuration = try await sourceVideoTrack.load(.minFrameDuration)

                let interpolator: DiveDataInterpolator
                do {
                    interpolator = try DiveDataInterpolator(samples: samples)
                } catch {
                    throw DiveExportError.invalidSamples
                }
                guard interpolator.samples.count >= 2 else {
                    throw DiveExportError.invalidSamples
                }
                try validate(sync: sync)

                let videoComposition = try makeVideoComposition(
                    sourceVideoTrack: sourceVideoTrack,
                    duration: duration,
                    naturalSize: naturalSize,
                    preferredTransform: preferredTransform,
                    sourceFrameDuration: sourceFrameDuration,
                    interpolator: interpolator,
                    sync: sync,
                    settings: settings
                )

                let outputDirectory = outputURL.deletingLastPathComponent()
                try FileManager.default.createDirectory(
                    at: outputDirectory,
                    withIntermediateDirectories: true
                )

                guard let session = AVAssetExportSession(
                    asset: asset,
                    presetName: settings.quality
                ) else {
                    throw DiveExportError.cannotCreateExportSession
                }
                guard session.supportedFileTypes.contains(settings.outputFileType) else {
                    throw DiveExportError.unsupportedOutputType
                }

                if FileManager.default.fileExists(atPath: outputURL.path) {
                    try FileManager.default.removeItem(at: outputURL)
                }

                session.videoComposition = videoComposition
                session.outputURL = outputURL
                session.outputFileType = settings.outputFileType
                session.shouldOptimizeForNetworkUse = true

                try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                    session.exportAsynchronously {
                        switch session.status {
                        case .completed:
                            continuation.resume(returning: ())
                        case .failed:
                            continuation.resume(
                                throwing: session.error ?? DiveExportError.exportFailed("未知錯誤")
                            )
                        case .cancelled:
                            continuation.resume(throwing: CancellationError())
                        default:
                            continuation.resume(throwing: DiveExportError.exportFailed(
                                "輸出工作未正常完成（狀態碼：\(session.status.rawValue)）"
                            ))
                        }
                    }
                }

                guard FileManager.default.fileExists(atPath: outputURL.path) else {
                    throw DiveExportError.exportFailed("輸出工作回報完成，但找不到產生的檔案。")
                }
                completion(.success(outputURL))
            } catch {
                completion(.failure(error))
            }
        }
    }

    private func validate(settings: DiveExportSettings) throws {
        guard !settings.quality.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              settings.overlayOpacity.isFinite,
              (0.0...1.0).contains(settings.overlayOpacity),
              settings.overlayScale.isFinite,
              (0.25...2.0).contains(settings.overlayScale),
              settings.overlayBottomInset.isFinite,
              (0.0...0.5).contains(settings.overlayBottomInset) else {
            throw DiveExportError.invalidSettings
        }
    }

    private func validate(sync: TimelineSync) throws {
        let first = sync.first
        guard first.videoSeconds.isFinite, first.watchSeconds.isFinite else {
            throw DiveExportError.invalidSync
        }
        if let second = sync.second {
            guard second.videoSeconds.isFinite,
                  second.watchSeconds.isFinite,
                  second.videoSeconds > first.videoSeconds,
                  second.watchSeconds > first.watchSeconds else {
                throw DiveExportError.invalidSync
            }
            let rate = (second.watchSeconds - first.watchSeconds) /
                (second.videoSeconds - first.videoSeconds)
            guard rate.isFinite, (0.90...1.10).contains(rate) else {
                throw DiveExportError.invalidSync
            }
        }
    }

    private func makeVideoComposition(
        sourceVideoTrack: AVAssetTrack,
        duration: CMTime,
        naturalSize: CGSize,
        preferredTransform: CGAffineTransform,
        sourceFrameDuration: CMTime,
        interpolator: DiveDataInterpolator,
        sync: TimelineSync,
        settings: DiveExportSettings
    ) throws -> AVMutableVideoComposition {
        let samples = interpolator.samples
        guard samples.count >= 2,
              duration.seconds.isFinite,
              duration.seconds > 0 else {
            throw DiveExportError.invalidSamples
        }

        let transformValues = [
            preferredTransform.a, preferredTransform.b,
            preferredTransform.c, preferredTransform.d,
            preferredTransform.tx, preferredTransform.ty
        ]
        guard naturalSize.width.isFinite,
              naturalSize.height.isFinite,
              naturalSize.width > 0,
              naturalSize.height > 0,
              transformValues.allSatisfy({ $0.isFinite }) else {
            throw DiveExportError.invalidRenderSize
        }

        let transformedRect = CGRect(origin: .zero, size: naturalSize).applying(preferredTransform)
        let renderSize = CGSize(
            width: abs(transformedRect.width).rounded(),
            height: abs(transformedRect.height).rounded()
        )
        guard renderSize.width.isFinite,
              renderSize.height.isFinite,
              renderSize.width > 0,
              renderSize.height > 0 else {
            throw DiveExportError.invalidRenderSize
        }

        let normalize = preferredTransform.concatenating(
            CGAffineTransform(
                translationX: -transformedRect.minX,
                y: -transformedRect.minY
            )
        )

        let frames = animationFrames(
            samples: samples,
            videoDuration: duration.seconds,
            sync: sync
        )
        guard !frames.isEmpty else {
            throw DiveExportError.noSamplesInVideoRange
        }

        let composition = AVMutableVideoComposition()
        composition.renderSize = renderSize
        composition.frameDuration = sourceFrameDuration.isValid &&
            sourceFrameDuration.seconds.isFinite && sourceFrameDuration.seconds > 0
            ? sourceFrameDuration
            : CMTime(value: 1, timescale: 30)

        let instruction = AVMutableVideoCompositionInstruction()
        instruction.timeRange = CMTimeRange(start: .zero, duration: duration)

        let layerInstruction = AVMutableVideoCompositionLayerInstruction(assetTrack: sourceVideoTrack)
        layerInstruction.setTransform(normalize, at: .zero)
        instruction.layerInstructions = [layerInstruction]
        composition.instructions = [instruction]

        let parent = CALayer()
        parent.frame = CGRect(origin: .zero, size: renderSize)
        parent.isGeometryFlipped = true

        let videoLayer = CALayer()
        videoLayer.frame = parent.bounds
        parent.addSublayer(videoLayer)

        let hud = makeHUDLayer(
            size: renderSize,
            samples: samples,
            videoDuration: duration.seconds,
            interpolator: interpolator,
            frames: frames,
            settings: settings
        )
        parent.addSublayer(hud)

        composition.animationTool = AVVideoCompositionCoreAnimationTool(
            postProcessingAsVideoLayer: videoLayer,
            in: parent
        )
        return composition
    }

    private func makeHUDLayer(
        size: CGSize,
        samples: [DiveSample],
        videoDuration: Double,
        interpolator: DiveDataInterpolator,
        frames: [(videoTime: Double, watchTime: Double)],
        settings: DiveExportSettings
    ) -> CALayer {
        let width = size.width * 0.92 * settings.overlayScale
        let height = size.height * 0.235 * settings.overlayScale
        let x = (size.width - width) / 2
        let y = size.height * (1 - settings.overlayBottomInset) - height

        let root = CALayer()
        root.frame = CGRect(x: x, y: y, width: width, height: height)
        root.opacity = settings.overlayOpacity
        root.cornerRadius = max(12, height * 0.08)
        root.backgroundColor = UIColor(red: 0.015, green: 0.075, blue: 0.12, alpha: 0.78).cgColor
        root.borderColor = UIColor(red: 0.28, green: 0.91, blue: 0.97, alpha: 0.48).cgColor
        root.borderWidth = max(1, size.width * 0.001)
        root.masksToBounds = true

        let cyan = UIColor(red: 0.28, green: 0.91, blue: 0.97, alpha: 1)
        let leftWidth = width * 0.34
        let labelFont = UIFont.monospacedSystemFont(ofSize: max(10, height * 0.075), weight: .bold)
        let valueFont = UIFont.monospacedDigitSystemFont(ofSize: max(18, height * 0.17), weight: .bold)

        addAnimatedMetric(
            to: root,
            label: "DEPTH",
            x: width * 0.035,
            y: height * 0.12,
            width: leftWidth,
            height: height * 0.23,
            interpolator: interpolator,
            frames: frames,
            videoDuration: videoDuration,
            font: valueFont,
            labelFont: labelFont,
            color: cyan,
            value: { String(format: "%.1f", $0.depthMeters) },
            unit: "m"
        )
        addAnimatedMetric(
            to: root,
            label: "DIVE TIME",
            x: width * 0.035,
            y: height * 0.40,
            width: leftWidth,
            height: height * 0.23,
            interpolator: interpolator,
            frames: frames,
            videoDuration: videoDuration,
            font: valueFont,
            labelFont: labelFont,
            color: cyan,
            value: { String(format: "%02d:%02d", Int($0.elapsedSeconds) / 60, Int($0.elapsedSeconds) % 60) },
            unit: ""
        )
        addAnimatedMetric(
            to: root,
            label: "RATE",
            x: width * 0.035,
            y: height * 0.68,
            width: leftWidth,
            height: height * 0.23,
            interpolator: interpolator,
            frames: frames,
            videoDuration: videoDuration,
            font: valueFont,
            labelFont: labelFont,
            color: cyan,
            value: { String(format: "%.2f", abs($0.verticalSpeedMetersPerSecond ?? 0)) },
            unit: "m/s"
        )

        if settings.includeTemperature,
           let temperature = samples.compactMap(\.temperatureCelsius).first,
           temperature.isFinite {
            let temp = CATextLayer()
            temp.contentsScale = UIScreen.main.scale
            temp.string = String(format: "TEMP  %.1f°C", temperature)
            temp.font = labelFont
            temp.fontSize = labelFont.pointSize
            temp.foregroundColor = UIColor.white.cgColor
            temp.frame = CGRect(
                x: width * 0.035,
                y: height * 0.91,
                width: leftWidth,
                height: height * 0.08
            )
            root.addSublayer(temp)
        }

        if settings.includeDepthProfile {
            addDepthProfile(
                to: root,
                samples: samples,
                frames: frames,
                videoDuration: videoDuration,
                left: leftWidth + width * 0.045,
                top: height * 0.12,
                width: width * 0.57,
                height: height * 0.73,
                cyan: cyan
            )
        }
        return root
    }

    private func addAnimatedMetric(
        to root: CALayer,
        label: String,
        x: CGFloat,
        y: CGFloat,
        width: CGFloat,
        height: CGFloat,
        interpolator: DiveDataInterpolator,
        frames: [(videoTime: Double, watchTime: Double)],
        videoDuration: Double,
        font: UIFont,
        labelFont: UIFont,
        color: UIColor,
        value: (DiveReading) -> String,
        unit: String
    ) {
        let labelLayer = CATextLayer()
        labelLayer.contentsScale = UIScreen.main.scale
        labelLayer.string = label
        labelLayer.font = labelFont
        labelLayer.fontSize = labelFont.pointSize
        labelLayer.foregroundColor = color.cgColor
        labelLayer.frame = CGRect(x: x, y: y, width: width, height: height * 0.35)
        root.addSublayer(labelLayer)

        let valueLayer = CATextLayer()
        valueLayer.contentsScale = UIScreen.main.scale
        valueLayer.font = font
        valueLayer.fontSize = font.pointSize
        valueLayer.foregroundColor = UIColor.white.cgColor
        valueLayer.frame = CGRect(
            x: x,
            y: y + height * 0.30,
            width: width,
            height: height * 0.70
        )
        root.addSublayer(valueLayer)

        let strings = frames.compactMap { frame -> (videoTime: Double, text: String)? in
            guard let reading = interpolator.reading(at: frame.watchTime) else {
                return nil
            }
            return (frame.videoTime, value(reading))
        }
        guard let first = strings.first else { return }
        valueLayer.string = unit.isEmpty ? first.text : "\(first.text) \(unit)"
        guard strings.count > 1 else { return }

        let animation = CAKeyframeAnimation(keyPath: "string")
        animation.values = strings.map { $0.text + (unit.isEmpty ? "" : " \(unit)") }
        animation.keyTimes = keyTimes(strings.map { $0.videoTime }, duration: videoDuration)
        animation.duration = videoDuration
        animation.beginTime = AVCoreAnimationBeginTimeAtZero
        animation.calculationMode = .discrete
        animation.isRemovedOnCompletion = false
        animation.fillMode = .both
        valueLayer.add(animation, forKey: "hud-\(label)")
    }

    private func addDepthProfile(
        to root: CALayer,
        samples: [DiveSample],
        frames: [(videoTime: Double, watchTime: Double)],
        videoDuration: Double,
        left: CGFloat,
        top: CGFloat,
        width: CGFloat,
        height: CGFloat,
        cyan: UIColor
    ) {
        let maxDepth = max(5, ceil((samples.map(\.depthMeters).max() ?? 5) / 5) * 5)
        let chart = CALayer()
        chart.frame = CGRect(x: left, y: top, width: width, height: height)
        root.addSublayer(chart)

        for depth in stride(from: 0.0, through: maxDepth, by: 5.0) {
            let y = CGFloat(depth / maxDepth) * height
            let grid = CAShapeLayer()
            let line = UIBezierPath()
            line.move(to: CGPoint(x: 0, y: y))
            line.addLine(to: CGPoint(x: width, y: y))
            grid.path = line.cgPath
            grid.strokeColor = cyan.withAlphaComponent(0.22).cgColor
            grid.lineWidth = 1
            grid.lineDashPattern = [3, 4]
            chart.addSublayer(grid)

            let tick = CATextLayer()
            tick.contentsScale = UIScreen.main.scale
            tick.string = "\(Int(depth))m"
            tick.fontSize = max(8, height * 0.075)
            tick.foregroundColor = cyan.cgColor
            tick.frame = CGRect(x: -width * 0.10, y: y - 6, width: width * 0.09, height: 13)
            chart.addSublayer(tick)
        }

        let firstTime = samples.first!.elapsedSeconds
        let lastTime = max(samples.last!.elapsedSeconds, firstTime + 0.001)
        let profile = UIBezierPath()
        for (index, sample) in samples.enumerated() {
            let px = CGFloat((sample.elapsedSeconds - firstTime) / (lastTime - firstTime)) * width
            let py = CGFloat(sample.depthMeters / maxDepth) * height
            let point = CGPoint(x: px, y: py)
            if index == 0 { profile.move(to: point) } else { profile.addLine(to: point) }
        }
        let glow = CAShapeLayer()
        glow.path = profile.cgPath
        glow.strokeColor = cyan.withAlphaComponent(0.35).cgColor
        glow.fillColor = UIColor.clear.cgColor
        glow.lineWidth = max(3, width * 0.012)
        glow.lineCap = .round
        glow.shadowColor = cyan.cgColor
        glow.shadowOpacity = 0.9
        glow.shadowRadius = 5
        chart.addSublayer(glow)

        let line = CAShapeLayer()
        line.path = profile.cgPath
        line.strokeColor = UIColor.white.cgColor
        line.fillColor = UIColor.clear.cgColor
        line.lineWidth = max(1.5, width * 0.006)
        line.lineCap = .round
        chart.addSublayer(line)

        let playhead = CALayer()
        playhead.backgroundColor = cyan.cgColor
        playhead.bounds = CGRect(x: 0, y: 0, width: max(2, width * 0.003), height: height)
        chart.addSublayer(playhead)

        let positions = frames.map { frame -> NSValue in
            let fraction = min(max((frame.watchTime - firstTime) / (lastTime - firstTime), 0), 1)
            let px = CGFloat(fraction) * width
            return NSValue(cgPoint: CGPoint(x: px, y: height / 2))
        }
        if let first = positions.first { playhead.position = first.cgPointValue }
        if positions.count > 1 {
            let movement = CAKeyframeAnimation(keyPath: "position")
            movement.values = positions
            movement.keyTimes = keyTimes(frames.map(\.videoTime), duration: videoDuration)
            movement.duration = videoDuration
            movement.beginTime = AVCoreAnimationBeginTimeAtZero
            movement.isRemovedOnCompletion = false
            movement.fillMode = .both
            playhead.add(movement, forKey: "depth-playhead")
        }
    }

    private func animationFrames(
        samples: [DiveSample],
        videoDuration: Double,
        sync: TimelineSync
    ) -> [(videoTime: Double, watchTime: Double)] {
        samples.compactMap { sample in
            // Invert watchTime(videoTime) for affine one/two-point sync.
            let first = sync.first
            let second = sync.second
            let videoTime: Double
            if let second {
                let rate = (second.watchSeconds - first.watchSeconds) /
                    (second.videoSeconds - first.videoSeconds)
                videoTime = first.videoSeconds + (sample.elapsedSeconds - first.watchSeconds) / rate
            } else {
                videoTime = first.videoSeconds + sample.elapsedSeconds - first.watchSeconds
            }
            guard videoTime.isFinite,
                  videoTime >= 0,
                  videoTime <= videoDuration else { return nil }
            return (videoTime, sample.elapsedSeconds)
        }.sorted { $0.videoTime < $1.videoTime }
    }

    private func keyTimes(_ times: [Double], duration: Double) -> [NSNumber] {
        guard duration.isFinite, duration > 0 else { return [] }
        // Keep one key time for every animation value. Samples are already
        // strictly time-ordered by DiveDataInterpolator and TimelineSync has
        // a positive rate, so the resulting values remain ordered.
        return times.map { time in
            let safeTime = time.isFinite ? time : 0
            let normalized = min(max(safeTime / duration, 0), 1)
            return NSNumber(value: normalized)
        }
    }
}
