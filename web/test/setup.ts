import '@testing-library/jest-dom/vitest'

// The app reads chain identity from configuration with no defaults (004 section 9),
// so tests must supply it the same way a build does.
import.meta.env.VITE_CHAIN_ID = '31337'
import.meta.env.VITE_RPC_URL = 'http://127.0.0.1:8545'
import.meta.env.VITE_API_URL = 'http://127.0.0.1:8080'

// Reown AppKit will not construct without a project id, so `env` requires one.
// Nothing under test opens the modal or reaches the relay — this only has to be
// non-empty, and a placeholder is preferable to a real id in a committed file.
import.meta.env.VITE_REOWN_PROJECT_ID = 'test-project-id'
