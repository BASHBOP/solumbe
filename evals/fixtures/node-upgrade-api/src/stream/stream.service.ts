import { StreamClient } from "@stream-io/node-sdk";

export class StreamService {
  private readonly client = new StreamClient(process.env.STREAM_KEY ?? "", process.env.STREAM_SECRET ?? "");

  async startCallRecording(callId: string): Promise<void> {
    const call = this.client.video.call("livestream", callId);
    await call.startRecording();
  }

  async stopCallRecording(callId: string): Promise<void> {
    const call = this.client.video.call("livestream", callId);
    await call.stopRecording();
  }
}
