import { Button } from "@/components/ui/button";
import Link from "next/link";

export default function WritingLanding() {
  return (
    <div className="min-h-screen bg-[#FEFCF8]">
      {/* Hero Section */}
      <section className="px-6 py-16 md:py-32 lg:py-32 bg-[#F8F6F0]">
        <div className="max-w-4xl mx-auto text-center">
          {/* Logo/Wordmark */}
          <div className="mb-12 flex justify-center items-center gap-2">
            <svg
              version="1.2"
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 128 128"
              width="64"
              height="64"
              fill="#1D4528"
            >
              <path
                fillRule="#1D4528"
                d="m6 45c0-21.5 17.5-39 39-39h38c21.5 0 39 17.5 39 39v38c0 21.5-17.5 39-39 39h-38c-21.5 0-39-17.5-39-39zm15.5-1.8c-1.2 0.7-2.3 1.6-2.9 2.9-1 2.1-1.2 4.4-0.8 6.6 0.6 2.7 3.9 3.1 6.3 1.5q0.9-0.6 1.9-1.3c2.8-1.6 6 0.8 5.8 3.9-0.2 2.3 1.5 4.1 3.8 4.1h1.5c2.8 0 5.2-2.3 5.5-5.1q0.3-2.6 0.8-5.1c0.7-3.7 3.6-6.6 7.3-7.3q2.5-0.5 5.1-0.8c2.8-0.3 5.1-2.7 5.1-5.6v-1.5c0-2.2-1.8-4-4-3.8-3.2 0.3-5.6-3-3.9-5.7q0.6-1 1.3-2c1.5-2.3 1.1-5.6-1.6-6.2-2.1-0.4-4.4-0.3-6.5 0.7-1.3 0.7-2.3 1.8-3 3q-0.8 1.2-1.5 2.5c-4.1 7.4-10.3 13.6-17.7 17.7q-1.2 0.7-2.5 1.5zm63.3-21.7c-0.7-1.2-1.7-2.3-2.9-3-2.2-1-4.5-1.1-6.6-0.7-2.7 0.6-3.1 3.9-1.6 6.2q0.7 1 1.3 2c1.7 2.7-0.7 6-3.9 5.7-2.2-0.2-4 1.6-4 3.8v1.5c0 2.9 2.3 5.3 5.1 5.6q2.6 0.3 5.1 0.8c3.7 0.7 6.6 3.6 7.3 7.3q0.5 2.5 0.8 5.1c0.3 2.8 2.7 5.1 5.5 5.1h1.5c2.3 0 4-1.8 3.9-4.1-0.3-3.1 2.9-5.5 5.7-3.9q1 0.7 2 1.3c2.3 1.6 5.6 1.2 6.2-1.5 0.4-2.2 0.2-4.5-0.8-6.6-0.6-1.3-1.7-2.2-2.9-2.9q-1.3-0.8-2.5-1.5c-7.4-4.1-13.6-10.3-17.7-17.7q-0.7-1.3-1.5-2.5zm21.7 63.3c1.2-0.7 2.3-1.7 2.9-3 1-2.1 1.2-4.4 0.8-6.5-0.6-2.8-3.9-3.1-6.2-1.6q-1 0.7-2 1.3c-2.8 1.7-6-0.7-5.7-3.9 0.1-2.2-1.6-4-3.9-4h-1.5c-2.8 0-5.2 2.2-5.5 5.1q-0.3 2.5-0.8 5.1c-0.7 3.7-3.6 6.6-7.3 7.3q-2.5 0.5-5.1 0.8c-2.8 0.3-5.1 2.6-5.1 5.5v1.5c0 2.2 1.8 4 4 3.8 3.2-0.2 5.6 3 3.9 5.7q-0.6 1-1.3 2c-1.5 2.3-1.1 5.6 1.6 6.2 2.1 0.5 4.4 0.3 6.5-0.7 1.3-0.6 2.3-1.7 3-2.9q0.8-1.3 1.5-2.5c4.1-7.5 10.3-13.7 17.7-17.8q1.3-0.7 2.5-1.4zm-63.3 21.7c0.7 1.2 1.7 2.3 3 2.9 2.1 1 4.4 1.2 6.5 0.7 2.7-0.6 3.1-3.9 1.6-6.2q-0.7-1-1.3-2c-1.7-2.7 0.7-5.9 3.9-5.7 2.2 0.2 4-1.6 4-3.8v-1.5c0-2.9-2.3-5.2-5.1-5.5q-2.6-0.3-5.1-0.8c-3.7-0.7-6.6-3.6-7.3-7.3q-0.5-2.6-0.8-5.1c-0.3-2.9-2.7-5.1-5.5-5.1h-1.5c-2.3 0-4 1.8-3.8 4 0.2 3.2-3 5.6-5.7 3.9q-1.1-0.6-2-1.3c-2.4-1.5-5.7-1.2-6.3 1.6-0.4 2.1-0.2 4.4 0.8 6.5 0.6 1.3 1.7 2.2 2.9 3q1.3 0.7 2.5 1.4c7.4 4.1 13.6 10.3 17.7 17.8q0.7 1.2 1.5 2.5z"
              />
            </svg>
          </div>

          {/* Main Headline */}
          <div className="mb-8">
            <h2 className="text-4xl md:text-6xl lg:text-7xl font-bold text-gray-900 leading-tight mb-6">
              Write Markdown{" "}
              <span className="italic text-[#1D4528]">Continuesly</span> Publish
            </h2>
          </div>

          {/* Philosophy Paragraph */}
          <div className="mb-12">
            <p className="text-lg md:text-xl text-gray-600 font-light max-w-2xl mx-auto leading-relaxed">
              We believe books shouldn’t be frozen in time. Metrists lets you
              publish long-form content iteratively—just like software.
            </p>
          </div>

          {/* Single CTA Button */}
          <div className="flex justify-center mb-20">
            <Link href="/docs">
              <Button
                size="lg"
                className="bg-[#1D4528] hover:bg-[#2A5A32] text-white px-10 py-4 rounded-full text-lg font-medium shadow-lg hover:shadow-xl transition-all duration-200"
              >
                Start Writing
              </Button>
            </Link>
          </div>
        </div>
      </section>

      {/* Learn More Section */}
      <section id="learn-more" className="px-6 py-16 md:py-20">
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-16">
            <h3 className="text-3xl md:text-4xl font-bold text-gray-900 mb-6">
              Why <span className="italic text-[#1D4528]">Metrists</span>{" "}
              matters
            </h3>
            <p className="text-lg text-gray-600 max-w-2xl mx-auto leading-relaxed">
              High-quality writing isn’t one-and-done. Metrists makes it easy to
              keep it alive.
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-8 md:gap-12">
            <div className="text-center">
              <h4 className="text-xl font-bold text-gray-900 mb-4">
                Simplicity{" "}
              </h4>
              <p className="text-gray-600 leading-relaxed">
                Cut through the noise with precise, purposeful language that
                communicates your message without ambiguity.
              </p>
            </div>
            <div className="text-center">
              <h4 className="text-xl font-bold text-gray-900 mb-4">Impact</h4>
              <p className="text-gray-600 leading-relaxed">
                Create lasting impressions through carefully chosen words that
                resonate with your audience's deepest needs.
              </p>
            </div>
            <div className="text-center">
              <h4 className="text-xl font-bold text-gray-900 mb-4">
                Authenticity
              </h4>
              <p className="text-gray-600 leading-relaxed">
                Develop a distinctive voice that reflects your unique
                perspective and builds genuine connections.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="px-6 py-12 border-t border-gray-200 bg-[#F8F6F0]">
        <div className="max-w-4xl mx-auto text-center">
          <p className="text-gray-500 text-sm">
            © {new Date().getFullYear()} Metrists.{" "}
            <Link
              href="https://github.com/metrists/metrists"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-[#1D4528] transition-colors duration-200"
            >
              Proudly Open-Source
            </Link>
            .{" "}
          </p>
        </div>
      </footer>
    </div>
  );
}
