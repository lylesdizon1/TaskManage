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
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: "flex", flexDirection: "column", alignItems: "center",
          justifyContent: "center", height: "100vh", fontFamily: "sans-serif",
          background: "#f9fafb", color: "#374151", padding: "2rem", textAlign: "center"
        }}>
          <div style={{ fontSize: "3rem", marginBottom: "1rem" }}>⚠️</div>
          <h2 style={{ fontSize: "1.5rem", marginBottom: "0.5rem" }}>Something went wrong</h2>
          <p style={{ color: "#6b7280", marginBottom: "1.5rem" }}>
            {this.state.error?.message || "An unexpected error occurred."}
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              background: "#4f46e5", color: "white", border: "none",
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
