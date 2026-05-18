import UploadReport from "@/components/UploadReport";

export default function HomePage() {
  return (
    <div className="max-w-3xl mx-auto p-8">
      <h1 className="text-2xl font-semibold mb-2">Upload Student Report</h1>
      <p className="text-zinc-600 mb-6 text-sm">
        Drop a .pdf / .docx / .doc. The agent reviews against your knowledge base
        (templates + samples) and flags critical/major issues for your approval.
      </p>
      <UploadReport />
    </div>
  );
}
