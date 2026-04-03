import type { AppProps } from "next/app";
import { Playfair_Display, Inter } from "next/font/google";
import "../app/globals.css";

const playfair = Playfair_Display({
  subsets: ["latin"],
  variable: "--font-playfair",
  display: "swap",
});

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

function MyApp({ Component, pageProps, router }: AppProps) {
    return (
        <div className={`${playfair.variable} ${inter.variable}`}>
            <Component {...pageProps} />
        </div>
    );
}

export default MyApp;
