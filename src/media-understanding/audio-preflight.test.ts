// Audio preflight tests cover auto mode, explicit disable, and transcript echo
// delivery settings.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
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

    const ctx: MsgContext = {
      Body: "<media:audio>",
      media: [
        { path: "/tmp/photo.jpg", contentType: "image/jpeg" },
        { path: "/tmp/voice.ogg", contentType: "audio/ogg" },
      ],
    };
    const transcript = await transcribeFirstAudio({ ctx, cfg: {} });

    expect(transcript).toBe("voice note transcript");
    expect(runAudioTranscriptionMock).toHaveBeenCalledTimes(1);
    expect(sendTranscriptEchoMock).not.toHaveBeenCalled();
    expect(ctx.media?.[0]?.transcribed).not.toBe(true);
    expect(ctx.media?.[1]?.transcribed).toBe(true);
  });

  it("transcribes AIFF voice notes without an explicit content type", async () => {
    runAudioTranscriptionMock.mockResolvedValueOnce({
      transcript: "AIFF voice note transcript",
      attachments: [],
    });

    const ctx: MsgContext = {
      Body: "<media:audio>",
      media: [{ path: "/tmp/voice.aiff" }],
    };

    await expect(transcribeFirstAudio({ ctx, cfg: {} })).resolves.toBe(
      "AIFF voice note transcript",
    );
    expect(runAudioTranscriptionMock).toHaveBeenCalledOnce();
    expect(ctx.media?.[0]?.transcribed).toBe(true);
  });

  it("transcribes an opaque audio source identified by separate filename metadata", async () => {
    runAudioTranscriptionMock.mockResolvedValueOnce({
      transcript: "voice note transcript",
      attachments: [],
    });
    const ctx: MsgContext = {
      Body: "<media:audio>",
      media: [
        {
          url: "https://cdn.example.test/download/opaque",
          fileName: "voice.ogg",
          contentType: "application/octet-stream",
        },
      ],
    };

    await expect(transcribeFirstAudio({ ctx, cfg: {} })).resolves.toBe("voice note transcript");
    expect(runAudioTranscriptionMock).toHaveBeenCalledOnce();
    expect(ctx.media?.[0]?.transcribed).toBe(true);
  });

  it("skips audio preflight when audio config is explicitly disabled", async () => {
    const transcript = await transcribeFirstAudio({
      ctx: {
        Body: "<media:audio>",
        media: [{ path: "/tmp/voice.ogg", contentType: "audio/ogg" }],
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
      media: [{ path: "/tmp/voice.ogg", contentType: "audio/ogg" }],
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
      media: [
        { path: "/tmp/photo.jpg", contentType: "image/jpeg" },
        { path: "/tmp/first-already-done.ogg", contentType: "audio/ogg", transcribed: true },
        { path: "/tmp/second-audio.ogg", contentType: "audio/ogg" },
        { path: "/tmp/clip.mp4", contentType: "video/mp4" },
      ],
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
      media: [{ path: "/tmp/voice.ogg", contentType: "audio/ogg" }],
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
      media: [{ path: "/tmp/voice.ogg", contentType: "audio/ogg" }],
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
