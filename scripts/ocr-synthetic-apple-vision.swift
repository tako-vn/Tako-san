#!/usr/bin/env swift
import Foundation
import Vision

struct Prepared: Decodable { let cases: [ImageCase] }
struct ImageCase: Decodable {
    let name: String
    let variant: String
    let path: String
    enum CodingKeys: String, CodingKey { case name = "case", variant, path }
}
struct Observation: Encodable {
    let text: String
    let x: Double
    let y: Double
    let confidence: Double
}
struct Run: Encodable {
    let name: String
    let variant: String
    let latencyMs: Double
    let observations: [Observation]
    enum CodingKeys: String, CodingKey { case name = "case", variant, latencyMs, observations }
}
struct Result: Encodable {
    let version = 1
    let engine = "Apple Vision VNRecognizeTextRequest"
    let language = "vi-VT,en-US"
    let runs: [Run]
}

let input = URL(fileURLWithPath: CommandLine.arguments.count > 1
    ? CommandLine.arguments[1] : ".artifacts/ocr-synthetic/prepared.synthetic.json")
let output = URL(fileURLWithPath: CommandLine.arguments.count > 2
    ? CommandLine.arguments[2] : ".artifacts/ocr-synthetic/apple-vision.raw.json")
let prepared = try JSONDecoder().decode(Prepared.self, from: Data(contentsOf: input))
var runs: [Run] = []
for image in prepared.cases {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.recognitionLanguages = ["vi-VT", "en-US"]
    let started = DispatchTime.now().uptimeNanoseconds
    try VNImageRequestHandler(url: URL(fileURLWithPath: image.path)).perform([request])
    let elapsed = Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000
    let observations = (request.results ?? []).compactMap { item -> Observation? in
        guard let text = item.topCandidates(1).first else { return nil }
        return Observation(text: text.string, x: Double(item.boundingBox.midX),
            y: Double(item.boundingBox.midY), confidence: Double(text.confidence))
    }
    runs.append(Run(name: image.name, variant: image.variant,
        latencyMs: elapsed, observations: observations))
}
let encoder = JSONEncoder()
encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
try encoder.encode(Result(runs: runs)).write(to: output, options: .atomic)
print("Apple Vision processed \(runs.count) synthetic variants. Raw OCR is in \(output.path).")
