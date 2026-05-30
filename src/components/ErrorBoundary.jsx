import React from "react";

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error("[ErrorBoundary] Caught error:", error, info);

    const isChunkError =
      error?.message?.includes('Failed to fetch dynamically imported module') ||
      error?.message?.includes('Loading chunk') ||
      error?.name === 'ChunkLoadError';

    if (isChunkError) {
      const alreadyReloaded = sessionStorage.getItem('chunk_reload_attempted');
      if (!alreadyReloaded) {
        sessionStorage.setItem('chunk_reload_attempted', '1');
        window.location.reload();
        return;
      }
      // Already tried once — clear flag and fall through to error UI
      sessionStorage.removeItem('chunk_reload_attempted');
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: "flex", flexDirection: "column", alignItems: "center",
          justifyContent: "center", height: "100vh", fontFamily: "sans-serif",
          background: "rgb(var(--surface-container-low))", color: "rgb(var(--text-primary))", padding: "2rem", textAlign: "center"
        }}>
          <div style={{ fontSize: "3rem", marginBottom: "1rem" }}>⚠️</div>
          <h2 style={{ fontSize: "1.5rem", marginBottom: "0.5rem" }}>Something went wrong</h2>
          <p style={{ color: "rgb(var(--text-secondary))", marginBottom: "1.5rem" }}>
            {this.state.error?.message || "An unexpected error occurred."}
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              background: "rgb(var(--accent))", color: "rgb(var(--accent-contrast))", border: "none",
              padding: "0.75rem 1.5rem", borderRadius: "0.5rem",
              cursor: "pointer", fontSize: "1rem"
            }}
          >
            Reload App
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
