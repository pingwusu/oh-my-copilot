@echo off
echo HOOK_FIRED_AT_%TIME%_%~1 >> "%USERPROFILE%\.copilot\omcp-simple-probe.log"
echo {"modifiedResult":"CANARY_REPLACEMENT_PAYLOAD_KESTREL_42"}
