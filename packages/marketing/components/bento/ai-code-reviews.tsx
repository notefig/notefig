import type React from "react"

const AiCodeReviews: React.FC = () => {
  const themeVars = {
    "--ai-primary-color": "hsl(var(--primary))",
    "--ai-background-color": "hsl(var(--background))",
    "--ai-text-color": "hsl(var(--foreground))",
    "--ai-text-dark": "hsl(var(--primary-foreground))",
    "--ai-border-color": "hsl(var(--border))",
    "--ai-border-main": "hsl(var(--foreground) / 0.1)",
    "--ai-highlight-primary": "hsl(var(--primary) / 0.12)",
    "--ai-highlight-header": "hsl(var(--accent) / 0.2)",
  }

  return (
    <div
      style={
        {
          width: "100%",
          height: "100%",
          position: "relative",
          background: "transparent",
          ...themeVars,
        } as React.CSSProperties
      }
      role="img"
      aria-label="AI Code Reviews interface showing code suggestions with apply buttons"
    >
      {/* Background Message Box (Blurred) */}
      <div
        style={{
          position: "absolute",
          top: "30px",
          left: "50%",
          transform: "translateX(-50%) scale(0.9)",
          width: "340px",
          height: "205.949px",
          background: "linear-gradient(180deg, var(--ai-background-color) 0%, transparent 100%)",
          opacity: 0.6,
          borderRadius: "8.826px",
          border: "0.791px solid var(--ai-border-color)",
          overflow: "hidden",
          backdropFilter: "blur(16px)",
        }}
      >
        <div
          className="border rounded-lg bg-card"
          style={{
            padding: "7.355px 8.826px",
            height: "100%",
            boxSizing: "border-box",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              fontFamily: "'Geist Mono', 'SF Mono', Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
              fontSize: "9.562px",
              lineHeight: "14.711px",
              letterSpacing: "-0.2942px",
              color: "hsl(var(--muted-foreground))",
              width: "100%",
              maxWidth: "320px",
              margin: 0,
            }}
          >
            <p style={{ margin: 0, whiteSpace: "pre-wrap", fontWeight: 400 }}>switch (type) {"{"}</p>
            <p style={{ margin: 0, whiteSpace: "pre-wrap", fontWeight: 400 }}> case 'success':</p>
            <p style={{ margin: 0, whiteSpace: "pre-wrap", fontWeight: 400 }}> return {"{"}</p>
            <p style={{ margin: 0, whiteSpace: "pre-wrap", fontWeight: 400 }}>
              {"          border: theme === 'dark' ? 'border-[rgba(34,197,94,0.4)]' : 'border-green-200',"}
            </p>
            <p style={{ margin: 0, whiteSpace: "pre-wrap", fontWeight: 400 }}> icon: (</p>
            <p style={{ margin: 0, whiteSpace: "pre-wrap", fontWeight: 400 }}>
              {'            <svg className={\'baseIconClasses\'} fill="none" viewBox="0 0 14 14">'}
            </p>
            <p style={{ margin: 0, whiteSpace: "pre-wrap", fontWeight: 400 }}> &lt;path</p>
            <p style={{ margin: 0, whiteSpace: "pre-wrap", fontWeight: 400 }}>
              {'                d="M3.85156 7.875L6.47656 10.5L10.8516 3.5"'}
            </p>
            <p style={{ margin: 0, whiteSpace: "pre-wrap", fontWeight: 400 }}>
              {'                stroke="var(--ai-primary-color)"'}
            </p>
            <p style={{ margin: 0, whiteSpace: "pre-wrap", fontWeight: 400 }}>
              {'                strokeLinecap="round"'}
            </p>
            <p style={{ margin: 0, whiteSpace: "pre-wrap", fontWeight: 400 }}>
              {'                strokeLinejoin="round"'}
            </p>
            <p style={{ margin: 0, whiteSpace: "pre-wrap", fontWeight: 400 }}>{'                strokeWidth="1.5"'}</p>
            <p style={{ margin: 0, whiteSpace: "pre-wrap", fontWeight: 400 }}> /&gt;</p>
            <p style={{ margin: 0, whiteSpace: "pre-wrap", fontWeight: 400 }}> &lt;/svg&gt;</p>
          </div>
        </div>
      </div>

      {/* Foreground Message Box (Main) */}
      <div
        style={{
          position: "absolute",
          top: "51.336px",
          left: "50%",
          transform: "translateX(-50%)",
          width: "340px",
          height: "221.395px",
          background: "var(--ai-background-color)",
          backdropFilter: "blur(16px)",
          borderRadius: "9.488px",
          border: "1px solid var(--ai-border-main)",
          overflow: "hidden",
        }}
      >
        <div
          className="bg-card border border-border"
          style={{
            padding: "9.488px",
            height: "100%",
            boxSizing: "border-box",
            position: "relative",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              width: "100%",
              top: "47.67px",
              height: "33.118px",
              background: "hsl(var(--foreground) / 0.08)",
              zIndex: 1,
            }}
          />
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              width: "100%",
              top: "80.791px",
              height: "45.465px",
              background: "var(--ai-highlight-primary)",
              zIndex: 1,
            }}
          />
          <div
            style={{
              fontFamily: "'Geist Mono', 'SF Mono', Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
              fontSize: "10.279px",
              lineHeight: "15.814px",
              letterSpacing: "-0.3163px",
              color: "var(--ai-text-color)",
              width: "100%",
              maxWidth: "320px",
              position: "relative",
              zIndex: 2,
              margin: 0,
            }}
          >
            <p style={{ margin: 0, whiteSpace: "pre-wrap", fontWeight: 400 }}>switch (type) {"{"}</p>
            <p style={{ margin: 0, whiteSpace: "pre-wrap", fontWeight: 400 }}> case 'success':</p>
            <p style={{ margin: 0, whiteSpace: "pre-wrap", fontWeight: 400 }}> return {"{"}</p>
            <p style={{ margin: 0, whiteSpace: "pre-wrap", fontWeight: 400 }}>
              {"          border: theme === 'dark' ? 'border-[rgba(34,197,94,0.4)]' : 'border-green-200',"}
            </p>
            <p style={{ margin: 0, whiteSpace: "pre-wrap", fontWeight: 400 }}> icon: (</p>
            <p style={{ margin: 0, whiteSpace: "pre-wrap", fontWeight: 400 }}>
              {'            <svg className={\'baseIconClasses\'} fill="none" viewBox="0 0 14 14">'}
            </p>
            <p style={{ margin: 0, whiteSpace: "pre-wrap", fontWeight: 400 }}> &lt;path</p>
            <p style={{ margin: 0, whiteSpace: "pre-wrap", fontWeight: 400 }}>
              {'                d="M3.85156 7.875L6.47656 10.5L10.8516 3.5"'}
            </p>
            <p style={{ margin: 0, whiteSpace: "pre-wrap", fontWeight: 400 }}>{'                stroke="#22C55E"'}</p>
            <p style={{ margin: 0, whiteSpace: "pre-wrap", fontWeight: 400 }}>
              {'                strokeLinecap="round"'}
            </p>
            <p style={{ margin: 0, whiteSpace: "pre-wrap", fontWeight: 400 }}>
              {'                strokeLinejoin="round"'}
            </p>
            <p style={{ margin: 0, whiteSpace: "pre-wrap", fontWeight: 400 }}>{'                strokeWidth="1.5"'}</p>
            <p style={{ margin: 0, whiteSpace: "pre-wrap", fontWeight: 400 }}> /&gt;</p>
            <p style={{ margin: 0, whiteSpace: "pre-wrap", fontWeight: 400 }}> &lt;/svg&gt;</p>
          </div>
          <button
            style={{
              position: "absolute",
              top: "calc(50% + 29.745px)",
              right: "20px",
              transform: "translateY(-50%)",
              zIndex: 3,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "3.953px",
              background: "var(--ai-primary-color)",
              color: "var(--ai-text-dark)",
              border: "none",
              cursor: "pointer",
              fontWeight: 500,
              whiteSpace: "nowrap",
              transition: "all 0.2s ease",
              padding: "3.163px 6.326px",
              borderRadius: "5.535px",
              fontSize: "10.279px",
              lineHeight: "15.814px",
              letterSpacing: "-0.3163px",
              boxShadow:
                "0px 26.093px 7.116px rgba(0, 0, 0, 0), 0px 16.605px 6.326px rgba(0, 0, 0, 0.01), 0px 9.488px 5.535px rgba(0, 0, 0, 0.05), 0px 3.953px 3.953px rgba(0, 0, 0, 0.09), 0px 0.791px 2.372px rgba(0, 0, 0, 0.1)",
            }}
          >
            <span
              style={{
                fontFamily: "'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
                fontWeight: 500,
              }}
            >
              Apply changes
            </span>
            <span
              style={{
                fontFamily: "'SF Pro', -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
                fontWeight: 500,
              }}
            >
              ⌘Y
            </span>
          </button>
        </div>
      </div>
    </div>
  )
}

export default AiCodeReviews
