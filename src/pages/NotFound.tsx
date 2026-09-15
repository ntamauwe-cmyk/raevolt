import { motion } from "framer-motion";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { RaevoltLogo, RAEVOLT_TAGLINE } from "@/components/brand";

export default function NotFound() {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.5 }}
      className="min-h-screen bg-[#080A24] text-zinc-100 flex flex-col"
    >
      {/* Main Content */}
      <div className="flex-1 flex flex-col items-center justify-center px-4">
        <div className="max-w-5xl mx-auto relative">
          <div className="flex flex-col items-center text-center">
            <RaevoltLogo />
            <h1 className="mt-10 text-5xl font-bold tracking-tight">404</h1>
            <p className="mt-2 text-lg text-zinc-400">Page Not Found</p>
            <p className="mt-1 text-xs uppercase tracking-[0.25em] text-zinc-600">
              {RAEVOLT_TAGLINE}
            </p>
            <Button asChild className="mt-8 bg-white text-zinc-900 hover:bg-zinc-200">
              <Link to="/">Back to RAEVOLT</Link>
            </Button>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
