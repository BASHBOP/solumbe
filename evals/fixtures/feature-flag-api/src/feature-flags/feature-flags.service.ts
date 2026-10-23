import production from "./config/environments/production.json";
import stableInt from "./config/environments/stable-int.json";

const ENVIRONMENTS: Record<string, { flags: Record<string, boolean | number | string> }> = {
  production,
  "stable-int": stableInt,
};

export class FeatureFlagsService {
  get(flag: string, environment = process.env.APP_ENV ?? "production") {
    return ENVIRONMENTS[environment]?.flags[flag];
  }
}
