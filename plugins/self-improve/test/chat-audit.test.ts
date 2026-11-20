import { expect, it } from "vitest";
import { chatAuditRow } from "../src/chat-audit.js";
it("hides revalidation record contents from the general chat audit view",()=>{
  const row={id:"a",at:1,namespace:"revalidation-workloads",key:"w",actor:"{}",reason:"Create",before_value:"null",after_value:JSON.stringify({cases:[{expected:"secret answer"}]})};
  const masked=chatAuditRow(row);
  expect(JSON.stringify(masked)).not.toContain("secret answer");expect(masked).toMatchObject({namespace:"revalidation-workloads",key:"w",before_value:null});
  const other={...row,namespace:"solutions"};expect(chatAuditRow(other)).toBe(other);
});
