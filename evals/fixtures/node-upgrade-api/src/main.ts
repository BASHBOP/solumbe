import { StreamService } from "./stream/stream.service";

export function bootstrap(): StreamService {
  return new StreamService();
}
