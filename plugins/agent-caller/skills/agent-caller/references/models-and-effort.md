# Models And Effort

Model catalogs belong to the provider and may depend on the project `cwd`, user
configuration, subscription, or compatible API endpoint. Always query
`list_models`; do not rely on a memorized static list.

Catalog entries can include:

- provider model ID;
- resolved model or alias mapping when available;
- provider-selected default;
- supported provider-defined effort strings.

For Codex, `advertised=false` means the model is explicitly configured but not
returned by experimental App Server `model/list`. Do not describe it as
permanently unsupported, but do not recommend it for the current runtime. Use
the advertised `selectedModel` as the recommendation. Pass the unadvertised ID
through only when the user explicitly selects it, and surface any provider
compatibility error directly.

Agent Caller does not translate effort labels across providers and does not
claim that a compatible endpoint implements an advertised effort identically.

## First Use In A Parent Task

For each provider and target `cwd`, query the live catalog before first
delegation. If the user did not already specify both model and effort, recommend
the live default and ask for a choice. Reuse that choice in the current parent
task.

Refresh and ask again when the provider or `cwd` changes, the user asks to
switch, or the selected model is no longer reported. This behavior belongs to
the Skill because standard MCP does not expose the parent Codex task ID.

## Defaults And Overrides

`model` and `effort` on `create_agent` are durable defaults for that Agent.
Values on `send_message` apply only to that Run. A later Run returns to the
Agent defaults or current provider configuration.

Every Run records its effective model and effort so status and history remain
explainable. Use only model IDs and effort values returned for that provider.
