export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return (
    <html lang="en">
      <body>
        <p>Something went wrong: {error.digest}</p>
      </body>
    </html>
  );
}
