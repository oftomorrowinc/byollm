/**
 * The one sentence that says "go and prove it works" — ruled 2026-09-02.
 *
 * ## Why it lives in the terminal
 *
 * The dashboard's approved banner used to say the device would start taking
 * work within a few seconds, and an earlier ruling would have put a test link
 * beside it. Both were wrong at the moment they rendered: `byollm setup` asks
 * "Run in background?" *after* the pairing ceremony — the correct order, since
 * install must never precede pairing — so at approval time the daemon may not
 * be installed or running at all.
 *
 * **A promise belongs to the party that can keep it.** The web knows one fact,
 * that the device was approved. Only this process watches the install succeed,
 * so only this process may say the device is ready to test.
 *
 * ## Why it is a constant
 *
 * Two callers print it: the end of `byollm setup`, and `byollm install` on its
 * own — the same moment reached two ways, and somebody who installs standalone
 * has exactly as much reason to be told. Written out twice it would be two
 * sentences within a month, and the walk that found this found it by reading
 * the words.
 *
 * "Connect BYOLLM" rather than "the BYOLLM button", because that is the label
 * on the control. The earlier wording sent people looking for something with a
 * different name on it.
 */
export const TEST_YOUR_DEVICE =
  "TEST YOUR DEVICE: Visit https://test.byollm.cloud and press the " +
  "Connect BYOLLM button.";
