# Coding workspace

Open **Surfaces → Coding workspace** in Monograph. The pane shows saved Git chats for the active **local** profile, grouped by the repository Hermes recorded. Pick a thread to open it in the main chat. Each row shows its branch and carries the checkout as a tooltip. Hidden, archived, and non-Git chats do not appear. The pane requests 200 sessions by creation time and sorts the returned Git threads by activity; Hermes may also return pinned rows. The Hermes sidebar is still the full session browser.

## Two threads, two worktrees

1. In the Hermes sidebar, enter a Git project. Choose **New worktree** and give it a branch name. Hermes creates the checkout and starts a chat there. To work in the project's current checkout instead, start a new chat from inside that project.
2. Do the same for a second branch. Send a prompt in each new chat so Hermes saves it. In a disposable repo, ask each thread to make a different edit to the same tracked file without committing it.
3. Open both saved threads in turn from **Coding workspace**. In the main chat, open **Toggle Git review**, select **Uncommitted**, and check that each thread only shows its own edit. Leave the review open while switching threads to check that it follows the main chat. If it was opened from a split chat and pinned to that checkout, close it and reopen from Coding workspace to return to the main chat's checkout.
4. In the native Review pane, use **Branch** for committed branch changes or **Last turn** for edits since the latest turn started. Check that the original checkout is still clean.

## Scope and testing

The current Desktop plugin SDK can open a saved chat and toggle Git Review. It cannot open the native New Worktree dialog or create a new chat bound to an arbitrary working directory. The plugin therefore leaves creation and Git operations to Hermes. It does not intercept shortcuts, simulate clicks, execute shell commands, or modify the app. It also does not try to retarget Review panes pinned from a split chat.

Run `npm test` for the repository's unit tests. The coding test creates and modifies two real Git worktrees and tests the Monograph pane against a Desktop SDK double. The steps above cover session binding and review in a real Desktop window; the SDK-double test does not exercise those native flows.
