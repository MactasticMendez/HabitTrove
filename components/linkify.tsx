import Linkify0 from "linkify-react";

export default function Linkify({ children }: { children: React.ReactNode }) {
  return <Linkify0 options={{ className: "underline", target: "_blank", rel: "noopener noreferrer" }}>{children}</Linkify0>;
}
