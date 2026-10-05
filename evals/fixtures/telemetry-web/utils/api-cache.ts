export class ApiCache {
  private entries = new Map<string, unknown>();
  private sessionErrors = 0;

  get(key: string) {
    try {
      return this.entries.get(key);
    } catch (error) {
      this.sessionErrors += 1;
      return undefined;
    }
  }

  set(key: string, value: unknown) {
    this.entries.set(key, value);
  }

  clear() {
    this.entries.clear();
  }

  getStats() {
    return { size: this.entries.size, sessionErrors: this.sessionErrors };
  }
}
