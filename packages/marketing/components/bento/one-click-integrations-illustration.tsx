import type React from "react"

interface OneClickIntegrationsIllustrationProps {
  className?: string
}

const OneClickIntegrationsIllustration: React.FC<OneClickIntegrationsIllustrationProps> = ({ className = "" }) => {
  const themeVars = {
    "--oci-primary-color": "hsl(var(--primary))",
    "--oci-background-color": "hsl(var(--background))",
    "--oci-foreground-color": "hsl(var(--foreground))",
    "--oci-muted-foreground-color": "hsl(var(--muted-foreground))",
    "--oci-border-color": "hsl(var(--border))",
    "--oci-shadow-color": "rgba(0, 0, 0, 0.12)",
    "--oci-gradient-light-gray-start": "hsl(var(--foreground) / 0.2)",
    "--oci-gradient-light-gray-end": "transparent",
  } as React.CSSProperties

  // Helper component for rendering each logo box
  const LogoBox: React.FC<{
    logoSvg?: React.ReactNode
    isGradientBg?: boolean
  }> = ({ logoSvg, isGradientBg }) => {
    const boxStyle: React.CSSProperties = {
      width: "60px",
      height: "60px",
      position: "relative",
      borderRadius: "9px",
      border: `1px ${themeVars["--oci-border-color"]} solid`,
      display: "flex",
      justifyContent: "center",
      alignItems: "center",
      overflow: "hidden",
      flexShrink: 0,
    }

    const innerContentStyle: React.CSSProperties = {
      width: "36px",
      height: "36px",
      position: "relative",
      overflow: "hidden",
      display: "flex",
      justifyContent: "center",
      alignItems: "center",
    }

    if (isGradientBg) {
      boxStyle.background = `linear-gradient(180deg, ${themeVars["--oci-gradient-light-gray-start"]} 0%, ${themeVars["--oci-gradient-light-gray-end"]} 100%)`
      boxStyle.boxShadow = `0px 1px 2px ${themeVars["--oci-shadow-color"]}`
      boxStyle.backdropFilter = "blur(18px)"
      boxStyle.padding = "6px 8px"
    }

    return <div style={boxStyle}>{logoSvg && <div style={innerContentStyle}>{logoSvg}</div>}</div>
  }

  // SVG content for logos, with fill/stroke updated to use CSS variables
  const FigmaLogo = (
    <svg width="36" height="37" viewBox="0 0 36 37" fill="none" xmlns="http://www.w3.org/2000/svg">
      <g clipPath="url(#clip0_254_68688)">
        <path
          d="M0.440897 22.2606C0.360977 21.9189 0.767777 21.704 1.01582 21.9521L14.1601 35.0964C14.4085 35.3448 14.1933 35.7516 13.8516 35.6713C7.21862 34.115 1.99682 28.8936 0.440897 22.2606ZM0.00061684 16.9923C-0.00235205 17.0427 0.00541993 17.0932 0.0234181 17.1404C0.0414162 17.1875 0.0692298 17.2303 0.105017 17.2659L18.8459 36.0079C18.9183 36.0799 19.018 36.1184 19.1195 36.1123C19.9727 36.0587 20.8097 35.9467 21.6262 35.7786C21.9016 35.7221 21.997 35.384 21.7983 35.1853L0.927257 14.3136C0.728537 14.1152 0.390497 14.2106 0.333977 14.486C0.164325 15.3126 0.0529306 16.1501 0.00061684 16.9923ZM1.5155 10.8061C1.48646 10.8719 1.47807 10.945 1.49144 11.0157C1.50481 11.0864 1.53931 11.1514 1.59038 11.2021L24.9097 34.5215C25.0138 34.6259 25.1711 34.6565 25.3057 34.5963C25.9463 34.311 26.5695 33.9883 27.1723 33.6301C27.2185 33.6024 27.2578 33.5644 27.287 33.5192C27.3163 33.4739 27.3348 33.4226 27.3412 33.3691C27.3475 33.3155 27.3415 33.2613 27.3237 33.2104C27.3059 33.1596 27.2766 33.1135 27.2382 33.0757L3.03686 8.87327C2.99905 8.8348 2.95294 8.8055 2.90206 8.78761C2.85118 8.76973 2.79687 8.76374 2.74331 8.7701C2.68976 8.77646 2.63836 8.795 2.59308 8.8243C2.5478 8.85361 2.50984 8.89289 2.4821 8.93914C2.12386 9.54195 1.80123 10.1652 1.51586 10.8057L1.5155 10.8061ZM4.55678 6.61894C4.49232 6.55515 4.45472 6.46909 4.45171 6.37845C4.4487 6.2878 4.48049 6.19944 4.54058 6.1315C7.8407 2.4379 12.6399 0.112305 17.9826 0.112305C27.933 0.112305 35.9999 8.17882 35.9999 18.1296C35.9999 23.472 33.6743 28.2715 29.9807 31.5713C29.9128 31.6313 29.8244 31.6631 29.7338 31.6601C29.6431 31.6571 29.5571 31.6195 29.4933 31.5551L4.55714 6.61894H4.55678Z"
          fill="var(--oci-primary-color)"
        />
      </g>
      <defs>
        <clipPath id="clip0_254_68688">
          <rect width="36" height="36" fill="white" transform="translate(0 0.112305)" />
        </clipPath>
      </defs>
    </svg>
  )

  const VercelLogo = (
    <svg width="36" height="37" viewBox="0 0 36 37" fill="none" xmlns="http://www.w3.org/2000/svg">
      <g clipPath="url(#clip0_254_68704)">
        <path
          d="M36 16.7736H25.4731L34.5898 11.51L32.5877 8.0412L23.471 13.3048L28.7333 4.18878L25.2645 2.18544L20.0022 11.3016V0.775391H15.9978V11.3026L10.7333 2.18544L7.26567 4.1878L12.5291 13.3037L3.41227 8.0412L1.41005 11.509L10.5268 16.7726H0V20.7772H10.5258L1.41005 26.0408L3.41227 29.5096L12.5281 24.247L7.26455 33.363L10.7333 35.3653L15.9968 26.2483V36.7754H20.0012V26.2492L25.2637 35.3653L28.7322 33.363L23.4689 24.246L32.5856 29.5096L34.5881 26.0408L25.4721 20.7782H35.9979V16.7736H36ZM18 24.2218C14.9805 24.2218 12.5331 21.7745 12.5331 18.7549C12.5331 15.7354 14.9805 13.2879 18 13.2879C21.0195 13.2879 23.4668 15.7354 23.4668 18.7549C23.4668 21.7745 21.0195 24.2218 18 24.2218Z"
          fill="var(--oci-primary-color)"
        />
      </g>
      <defs>
        <clipPath id="clip0_254_68704">
          <rect width="36" height="36" fill="white" transform="translate(0 0.775391)" />
        </clipPath>
      </defs>
    </svg>
  )

  const GitHubLogo = (
    <svg width="36" height="37" viewBox="0 0 36 37" fill="none" xmlns="http://www.w3.org/2000/svg">
      <g clipPath="url(#clip0_254_68698)">
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M18 0.111328C8.055 0.111328 0 8.16633 0 18.1113C0 26.0763 5.1525 32.8038 12.3075 35.1888C13.2075 35.3463 13.545 34.8063 13.545 34.3338C13.545 33.9063 13.5225 32.4888 13.5225 30.9813C9 31.8138 7.83 29.8788 7.47 28.8663C7.2675 28.3488 6.39 26.7513 5.625 26.3238C4.995 25.9863 4.095 25.1538 5.6025 25.1313C7.02 25.1088 8.0325 26.4363 8.37 26.9763C9.99 29.6988 12.5775 28.9338 13.6125 28.4613C13.77 27.2913 14.2425 26.5038 14.76 26.0538C10.755 25.6038 6.57 24.0513 6.57 17.1663C6.57 15.2088 7.2675 13.5888 8.415 12.3288C8.235 11.8788 7.605 10.0338 8.595 7.55883C8.595 7.55883 10.1025 7.08633 13.545 9.40383C14.985 8.99883 16.515 8.79633 18.045 8.79633C19.575 8.79633 21.105 8.99883 22.545 9.40383C25.9875 7.06383 27.495 7.55883 27.495 7.55883C28.485 10.0338 27.855 11.8788 27.675 12.3288C28.8225 13.5888 29.52 15.1863 29.52 17.1663C29.52 24.0738 25.3125 25.6038 21.3075 26.0538C21.96 26.6163 22.5225 27.6963 22.5225 29.3838C22.5225 31.7913 22.5 33.7263 22.5 34.3338C22.5 34.8063 22.8375 35.3688 23.7375 35.1888C30.8475 32.8038 36 26.0538 36 18.1113C36 8.16633 27.945 0.111328 18 0.111328Z"
          fill="var(--oci-primary-color)"
        />
      </g>
      <defs>
        <clipPath id="clip0_254_68698">
          <rect width="36" height="36" fill="white" transform="translate(0 0.111328)" />
        </clipPath>
      </defs>
    </svg>
  )

  const SlackLogo = (
    <svg width="36" height="29" viewBox="0 0 36 29" fill="none" xmlns="http://www.w3.org/2000/svg">
      <g clipPath="url(#clip0_254_68690)">
        <path
          d="M30.1094 1.82111C32.5374 0.000749489 36 1.73304 36 4.76642V25.6297C36 26.9857 34.9018 28.0846 33.5459 28.0848H27.8184V14.1746L18 21.5389L8.18164 14.1746V28.0848H2.45508C1.09889 28.0848 0 26.9858 0 25.6297V4.76642C0 1.73314 3.46259 0.000650114 5.89062 1.82111L8.18164 3.53888L18 10.9022L27.8184 3.53888L30.1094 1.82111Z"
          fill="var(--oci-primary-color)"
        />
      </g>
      <defs>
        <clipPath id="clip0_254_68690">
          <rect width="36" height="28.0842" fill="white" />
        </clipPath>
      </defs>
    </svg>
  )

  const VSCodeLogo = (
    <svg width="36" height="38" viewBox="0 0 36 38" fill="none" xmlns="http://www.w3.org/2000/svg">
      <g clipPath="url(#clip0_254_68700)">
        <path
          d="M21.043 36.4463C20.0985 37.6356 18.1836 36.984 18.1609 35.4653L17.8281 13.2539H32.7631C35.4682 13.2539 36.9769 16.3783 35.2948 18.4969L21.043 36.4463Z"
          fill="url(#paint0_linear_254_68700)"
        />
        <path
          d="M21.043 36.4463C20.0985 37.6356 18.1836 36.984 18.1609 35.4653L17.8281 13.2539H32.7631C35.4682 13.2539 36.9769 16.3783 35.2948 18.4969L21.043 36.4463Z"
          fill="url(#paint1_linear_254_68700)"
          fillOpacity="0.2"
        />
        <path
          d="M14.9668 0.706059C15.9112 -0.483394 17.8261 0.16834 17.8489 1.68697L17.9947 23.8984H3.24665C0.541445 23.8984 -0.967295 20.7739 0.714879 18.6554L14.9668 0.706059Z"
          fill="var(--oci-primary-color)"
        />
      </g>
      <defs>
        <linearGradient
          id="paint0_linear_254_68700"
          x1="17.8281"
          y1="18.1787"
          x2="31.1018"
          y2="23.7457"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="var(--oci-primary-color)" />
          <stop offset="1" stopColor="var(--oci-primary-color)" />
        </linearGradient>
        <linearGradient
          id="paint1_linear_254_68700"
          x1="11.9433"
          y1="10.1213"
          x2="17.9968"
          y2="21.5167"
          gradientUnits="userSpaceOnUse"
        >
          <stop />
          <stop offset="1" stopOpacity="0" />
        </linearGradient>
        <clipPath id="clip0_254_68700">
          <rect width="36" height="37.3211" fill="white" transform="translate(0 0.0224609)" />
        </clipPath>
      </defs>
    </svg>
  )

  // Define the grid items with their respective logos and properties
  const gridItems = Array(40)
    .fill(null)
    .map((_, i) => {
      const item: { logoSvg?: React.ReactNode; isGradientBg?: boolean } = {}
      const row = Math.floor(i / 10)
      const col = i % 10

      // Assign logos to specific positions
      if (row === 0 && col === 3) {
        item.logoSvg = FigmaLogo
        item.isGradientBg = true
      } else if (row === 1 && col === 5) {
        item.logoSvg = VercelLogo
        item.isGradientBg = true
      } else if (row === 2 && col === 3) {
        item.logoSvg = GitHubLogo
        item.isGradientBg = true
      } else if (row === 2 && col === 7) {
        item.logoSvg = SlackLogo
        item.isGradientBg = true
      } else if (row === 3 && col === 5) {
        item.logoSvg = VSCodeLogo
        item.isGradientBg = true
      }
      return item
    })

  return (
    <div
      className={`w-full h-full relative ${className}`}
      style={{
        ...themeVars,
      }}
      role="img"
      aria-label="One-click integrations illustration showing a grid of connected squares"
    >
      {/* Background radial gradient */}
      <div
        style={{
          width: "377.33px",
          height: "278.08px",
          left: "0px",
          top: "24px",
          position: "absolute",
          background: `radial-gradient(ellipse 103.87% 77.04% at 52.56% -1.80%, 
            ${themeVars["--oci-foreground-color"]}00 0%, 
            ${themeVars["--oci-foreground-color"]}F5 15%, 
            ${themeVars["--oci-foreground-color"]}66 49%, 
            ${themeVars["--oci-foreground-color"]}F5 87%, 
            ${themeVars["--oci-foreground-color"]}00 100%)`,
        }}
      />

      {/* Main content container with backdrop blur */}
      <div
        style={{
          width: "377px",
          height: "265px",
          left: "0.34px",
          top: "43.42px",
          position: "absolute",
          backdropFilter: "blur(7.91px)",
          display: "flex",
          flexDirection: "column",
          justifyContent: "flex-start",
          alignItems: "center",
          gap: "16px",
        }}
      >
        {/* Render rows of logo boxes */}
        {Array.from({ length: 4 }).map((_, rowIndex) => (
          <div
            key={rowIndex}
            style={{ display: "flex", justifyContent: "flex-start", alignItems: "center", gap: "16px" }}
          >
            {gridItems.slice(rowIndex * 10, (rowIndex + 1) * 10).map((item, colIndex) => (
              <LogoBox key={colIndex} {...item} />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

export default OneClickIntegrationsIllustration
