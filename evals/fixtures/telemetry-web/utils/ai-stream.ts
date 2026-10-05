export async function postAiStream(prompt: string, onError: (error: Error) => void) {
  const chunkBoundary = "\n\n";
  try {
    const response = await fetch("/api/ai", { method: "POST", body: prompt });
    return (await response.text()).split(chunkBoundary);
  } catch (error) {
    onError(error as Error);
    return [];
  }
}
