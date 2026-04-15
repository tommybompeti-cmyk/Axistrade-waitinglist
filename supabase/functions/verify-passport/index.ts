import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function runOCR(
  fileData: Blob,
  mimeType: string,
  apiKey: string
): Promise<string> {
  const arrayBuffer = await fileData.arrayBuffer();
  const base64 = arrayBufferToBase64(arrayBuffer);

  const form = new FormData();
  form.append("base64Image", `data:${mimeType};base64,${base64}`);
  form.append("apikey", apiKey);
  form.append("language", "eng");
  form.append("isOverlayRequired", "false");
  form.append("OCREngine", "2"); // more accurate engine

  const res = await fetch("https://api.ocr.space/parse/image", {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) throw new Error(`OCR API error: ${res.status}`);
  const data = await res.json();
  return data?.ParsedResults?.[0]?.ParsedText ?? "";
}

function getMimeType(url: string): string {
  const ext = url.split(".").pop()?.toLowerCase();
  if (ext === "pdf") return "application/pdf";
  if (ext === "png") return "image/png";
  return "image/jpeg";
}

function extractFilePath(url: string): string | null {
  const parts = url.split("/passport-documents/");
  return parts.length > 1 ? parts[1] : null;
}

// ── Main handler ─────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();

    // Support both direct call ({ passport_id }) and DB webhook payload ({ record })
    const passportId: string = body.passport_id ?? body.record?.id;

    if (!passportId) {
      return new Response(
        JSON.stringify({ error: "passport_id is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const ocrApiKey = Deno.env.get("OCR_SPACE_API_KEY") ?? "helloworld";

    // 1. Fetch passport record
    const { data: passport, error: fetchErr } = await supabase
      .from("trust_passports")
      .select("*")
      .eq("id", passportId)
      .single();

    if (fetchErr || !passport) {
      return new Response(
        JSON.stringify({ error: "Passport not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const notes: string[] = [];
    let scoreBonus = 0;
    let finalStatus = "pending";

    // ── 2. Validate registration number format ─────────────────────────────
    const saRegPattern = /^\d{4}\/\d{6}\/\d{2}$/;
    const regFormatValid = saRegPattern.test(passport.registration_number ?? "");

    if (regFormatValid) {
      notes.push("✓ Registration number format is valid");
      scoreBonus += 5;
    } else {
      notes.push("✗ Registration number format is invalid — expected YYYY/NNNNNN/07");
    }

    // ── 3. OCR the CIPC certificate ────────────────────────────────────────
    let cipcOcrPassed = false;
    let companyNameInDoc = false;

    if (passport.cipc_document_url) {
      const filePath = extractFilePath(passport.cipc_document_url);
      if (filePath) {
        try {
          const { data: fileData, error: dlErr } = await supabase.storage
            .from("passport-documents")
            .download(filePath);

          if (!dlErr && fileData) {
            const mimeType = getMimeType(passport.cipc_document_url);
            const extractedText = await runOCR(fileData, mimeType, ocrApiKey);
            const textUpper = extractedText.toUpperCase();

            // Check registration number is in the document
            const regNormalised = (passport.registration_number ?? "")
              .replace(/\//g, "/")
              .toUpperCase();
            if (textUpper.includes(regNormalised)) {
              cipcOcrPassed = true;
              scoreBonus += 15;
              notes.push("✓ Registration number found in CIPC document");
            } else {
              notes.push(
                "✗ Registration number not found in CIPC document — manual review required"
              );
            }

            // Check company name (at least one significant word matches)
            const companyWords = (passport.company_name ?? "")
              .toUpperCase()
              .split(/\s+/)
              .filter((w: string) => w.length > 3);
            const nameMatch = companyWords.some((w: string) => textUpper.includes(w));
            if (nameMatch) {
              companyNameInDoc = true;
              scoreBonus += 5;
              notes.push("✓ Company name matched in CIPC document");
            } else {
              notes.push(
                "✗ Company name not clearly matched in CIPC document — manual review required"
              );
            }
          } else {
            notes.push("⚠ Could not download CIPC document for verification");
          }
        } catch (err) {
          notes.push(`⚠ CIPC document OCR failed: ${(err as Error).message}`);
        }
      }
    } else {
      notes.push("✗ No CIPC document uploaded");
    }

    // ── 4. OCR the mining license ──────────────────────────────────────────
    let miningOcrPassed = false;

    if (passport.mining_license_url) {
      const filePath = extractFilePath(passport.mining_license_url);
      if (filePath) {
        try {
          const { data: fileData, error: dlErr } = await supabase.storage
            .from("passport-documents")
            .download(filePath);

          if (!dlErr && fileData) {
            const mimeType = getMimeType(passport.mining_license_url);
            const extractedText = await runOCR(fileData, mimeType, ocrApiKey);
            const textLower = extractedText.toLowerCase();

            const miningKeywords = [
              "mining right",
              "mineral right",
              "prospecting right",
              "mining licence",
              "mining license",
              "dmr",
              "dmre",
              "mineral resources",
              "department of mineral",
              "samrad",
            ];

            const keywordsFound = miningKeywords.filter((kw) =>
              textLower.includes(kw)
            );

            if (keywordsFound.length >= 1) {
              miningOcrPassed = true;
              scoreBonus += 10;
              notes.push(
                `✓ Mining license document verified (keywords: ${keywordsFound.slice(0, 2).join(", ")})`
              );
            } else {
              notes.push(
                "✗ Mining license: expected keywords not found — manual review required"
              );
            }
          } else {
            notes.push("⚠ Could not download mining license for verification");
          }
        } catch (err) {
          notes.push(`⚠ Mining license OCR failed: ${(err as Error).message}`);
        }
      }
    } else {
      notes.push("— No mining license uploaded (optional)");
    }

    // ── 5. CIPC live lookup (best-effort, no API key required) ────────────
    try {
      const cipcRes = await fetch(
        `https://efiling.cipc.co.za/CompanySearch/CompanyByEnterpriseNumber?enterpriseNumber=${encodeURIComponent(passport.registration_number ?? "")}`,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (compatible; AxisTrade-Verification/1.0; +https://axistradeafrica.com)",
            Accept: "application/json, text/html, */*",
          },
          signal: AbortSignal.timeout(10000),
        }
      );

      if (cipcRes.ok) {
        const text = await cipcRes.text();
        if (text && text.trim().length > 10 && !text.includes("error")) {
          scoreBonus += 10;
          notes.push("✓ CIPC live database lookup succeeded");
        } else {
          notes.push("— CIPC live lookup: no data returned (document OCR used instead)");
        }
      } else {
        notes.push(
          "— CIPC live lookup unavailable (document OCR used as primary check)"
        );
      }
    } catch (_) {
      notes.push(
        "— CIPC live lookup unavailable (document OCR used as primary check)"
      );
    }

    // ── 6. Determine final status and score ───────────────────────────────
    const newTrustScore = Math.min(100, (passport.trust_score ?? 0) + scoreBonus);

    if (cipcOcrPassed && companyNameInDoc && regFormatValid) {
      finalStatus = "auto_verified";
      notes.push("✓ Auto-verification passed — pending final human sign-off");
    } else if (regFormatValid && passport.cipc_document_url) {
      finalStatus = "pending";
      notes.push("— Requires manual review by AxisTrade team");
    } else {
      finalStatus = "pending";
      notes.push("— Incomplete submission — requires manual review");
    }

    // ── 7. Update the record ───────────────────────────────────────────────
    await supabase
      .from("trust_passports")
      .update({
        trust_score: newTrustScore,
        auto_verification_status: finalStatus,
        auto_verification_notes: notes.join("\n"),
        auto_verified_at: new Date().toISOString(),
      })
      .eq("id", passportId);

    return new Response(
      JSON.stringify({
        success: true,
        passport_id: passportId,
        status: finalStatus,
        trust_score: newTrustScore,
        notes,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
