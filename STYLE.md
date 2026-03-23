# Code Style

1. **Every line earns its keep.** Remove dead code, duplicate state, unused imports, and features that sound useful but don't pay off.

2. **Prefer direct flows over abstraction.** Flat control flow beats wrapper layers, single-use helpers, factories, and config-driven machinery.

3. **Extract only when it clarifies.** A helper should be repeated enough to matter, named better than the inline code, and not hide important behavior.

4. **One place owns the truth.** Don't duplicate authority across client/hub, docs/code, or command/tool paths unless there's a real payoff.

5. **Be explicit and honest.** Reject clearly, return truthful status, and avoid magic behavior that users or agents can't reason about.

6. **Keep structure proportional.** One cohesive file is fine if it stays readable. Split only when the file starts fighting change.

7. **Types clarify, not decorate.** Remove `any`, but prefer small local types over elaborate type scaffolding.

8. **User intent wins.** Explicit user actions override automatic behavior.

9. **Comments and docs match reality.** If the code or UX changes, stale comments and examples are bugs too.
