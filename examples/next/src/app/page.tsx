import { summarize } from "./actions";

/**
 * Something for Next to render, and a use for the action.
 *
 * Not part of the integration — the pattern is the route, `lib/byollm.ts` and
 * `actions.ts`. A Next app with no page is a degenerate build, and a
 * degenerate build is a weaker test of the thing that matters.
 */
export default function Page(): React.ReactElement {
  async function run(formData: FormData): Promise<void> {
    "use server";
    const transcript = formData.get("transcript");
    await summarize(typeof transcript === "string" ? transcript : "");
  }

  return (
    <main>
      <p>byollm example — the integration is in app/api/byollm.</p>
      <form action={run}>
        <textarea name="transcript" />
        <button type="submit">Summarize</button>
      </form>
    </main>
  );
}
