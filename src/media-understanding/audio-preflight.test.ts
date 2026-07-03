// Audio preflight tests cover auto mode, explicit disable, and transcript echo
// delivery settings.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { transcribeFirstAudio } from "./audio-preflight.js";

const runAudioTranscriptionMock = vi.hoisted(() => vi.fn());
const sendTranscriptEchoMock = vi.hoisted(() => vi.fn());

vi.mock("./audio-transcription-runner.js", () => ({
  runAudioTranscription: (...args: unknown[]) => runAudioTranscriptionMock(...args),
}));

vi.mock("./echo-transcript.js", () => ({
  DEFAULT_ECHO_TRANSCRIPT_FORMAT: '📝 "{transcript}"',
  sendTranscriptEcho: (...args: unknown[]) => sendTranscriptEchoMock(...args),
}));

describe("transcribeFirstAudio", () => {
  beforeEach(() => {
    runAudioTranscriptionMock.mockReset();
    sendTranscriptEchoMock.mockReset();
  });

  it("runs audio preflight in auto mode when audio config is absent", async () => {
    runAudioTranscriptionMock.mockResolvedValueOnce({
      transcript: "voice note transcript",
      attachments: [],
    });

    const transcript = await transcribeFirstAudio({
      ctx: {
        Body: "<media:audio>",
        MediaPath: "/tmp/voice.ogg",
        MediaType: "audio/ogg",
      },
      cfg: {},
    });

    expect(transcript).toBe("voice note transcript");
    expect(runAudioTranscriptionMock).toHaveBeenCalledTimes(1);
    expect(sendTranscriptEchoMock).not.toHaveBeenCalled();
  });

  it("skips audio preflight when audio config is explicitly disabled", async () => {
    const transcript = await transcribeFirstAudio({
      ctx: {
        Body: "<media:audio>",
        MediaPath: "/tmp/voice.ogg",
        MediaType: "audio/ogg",
      },
      cfg: {
        tools: {
          media: {
            audio: {
              enabled: false,
            },
          },
        },
      },
    });

    expect(transcript).toBeUndefined();
    expect(runAudioTranscriptionMock).not.toHaveBeenCalled();
    expect(sendTranscriptEchoMock).not.toHaveBeenCalled();
  });

  it("echoes the preflight transcript when echoTranscript is enabled", async () => {
    runAudioTranscriptionMock.mockResolvedValueOnce({
      transcript: "hello from dm audio",
      attachments: [],
    });

    const ctx = {
      Body: "<media:audio>",
      Provider: "telegram",
      OriginatingTo: "telegram:42",
      AccountId: "default",
      MediaPath: "/tmp/voice.ogg",
      MediaType: "audio/ogg",
    };
    const cfg = {
      tools: {
        media: {
          audio: {
            enabled: true,
            echoTranscript: true,
            echoFormat: "Heard: {transcript}",
          },
        },
      },
    };

    const transcript = await transcribeFirstAudio({ ctx, cfg });

    expect(transcript).toBe("hello from dm audio");
    expect(sendTranscriptEchoMock).toHaveBeenCalledOnce();
    expect(sendTranscriptEchoMock).toHaveBeenCalledWith({
      ctx,
      cfg,
      transcript: "hello from dm audio",
      format: "Heard: {transcript}",
    });
  });

  it("passes only the first untranscribed audio attachment to transcriber", async () => {
    runAudioTranscriptionMock.mockResolvedValueOnce({
      transcript: "hello from second audio",
      attachments: [],
    });

    const ctx = {
      Body: "<media:image><media:audio><media:audio><media:video>",
      MediaPaths: [
        "/tmp/photo.jpg",
        "/tmp/first-already-done.ogg",
        "/tmp/second-audio.ogg",
        "/tmp/clip.mp4",
      ],
      MediaTypes: ["image/jpeg", "audio/ogg", "audio/ogg", "video/mp4"],
      MediaTranscribedIndexes: [1],
    };

    const transcript = await transcribeFirstAudio({ ctx, cfg: {} });

    expect(transcript).toBe("hello from second audio");

    expect(runAudioTranscriptionMock).toHaveBeenCalledTimes(1);
    const runArgs = runAudioTranscriptionMock.mock.calls[0]?.[0] as
      | { attachments?: unknown[] }
      | undefined;
    expect(runArgs).toBeDefined();
    expect(Array.isArray(runArgs?.attachments)).toBe(true);
    expect(runArgs?.attachments).toHaveLength(1);
    expect(runArgs?.attachments?.[0]).toEqual(
      expect.objectContaining({
        path: "/tmp/second-audio.ogg",
        index: 2,
        mime: "audio/ogg",
      }),
    );
  });

  it("returns transcript when transcript echo fails", async () => {
    runAudioTranscriptionMock.mockResolvedValueOnce({
      transcript: "hello from dm audio",
      attachments: [],
    });
    sendTranscriptEchoMock.mockRejectedValueOnce(new Error("transcript echo failed"));

    const ctx = {
      Body: "<media:audio>",
      Provider: "telegram",
      OriginatingTo: "telegram:42",
      AccountId: "default",
      MediaPath: "/tmp/voice.ogg",
      MediaType: "audio/ogg",
    };
    const cfg = {
      tools: {
        media: {
          audio: {
            enabled: true,
            echoTranscript: true,
            echoFormat: "Heard: {transcript}",
          },
        },
      },
    };

    const transcript = await transcribeFirstAudio({ ctx, cfg });

    expect(transcript).toBe("hello from dm audio");
    expect(sendTranscriptEchoMock).toHaveBeenCalledOnce();
  });

  it("stores transcript metadata from provider output on successful preflight", async () => {
    runAudioTranscriptionMock.mockResolvedValueOnce({
      transcript: "Bitte den Entwurf fuer Emily ablegen",
      attachments: [],
      provider: "test",
      model: "mock-audio",
    });

    const ctx = {
      Body: "<media:audio>",
      MediaPath: "/tmp/voice.ogg",
      MediaType: "audio/ogg",
    };

    const transcript = await transcribeFirstAudio({ ctx, cfg: {} });

    expect(transcript).toBe("Bitte den Entwurf fuer Emily ablegen");
    expect((ctx as Record<string, unknown>).AudioTranscriptText).toBe(
      "Bitte den Entwurf fuer Emily ablegen",
    );
    expect((ctx as Record<string, unknown>).AudioTranscriptProvider).toBe("test");
    expect((ctx as Record<string, unknown>).AudioTranscriptModel).toBe("mock-audio");
    expect((ctx as Record<string, unknown>).AudioTranscriptSource).toBe("preflight");
  });
});
