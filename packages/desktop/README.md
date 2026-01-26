# Thoughts on Architecture

- Tinybase acts as the in-memory state management and interacts with persistance layer
- When in "workspace" mode, we should be able to assume that persister has loaded all data into tinybase
- For local fs, the rust binding should directly output tinybase-compatible changes
- Settings may also be stored in fs as an artifact
- Later when we add Metrists Cloud, we'd add another persister and CRDT
