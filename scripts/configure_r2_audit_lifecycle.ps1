param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$')]
    [string]$BucketName,

    [switch]$Apply,

    [string]$Confirm = ''
)

$ErrorActionPreference = 'Stop'
$requiredConfirm = 'APPLY_STOCKVISION_R2_AUDIT_LIFECYCLE'
$rules = @(
    @{
        Id = 'sv-audit-strategy-decisions-5y'
        Prefix = 'archives/d1_audit_json_archive/target=strategy_decision_log/'
        IaDays = 90
        ExpireDays = 1825
    },
    @{
        Id = 'sv-audit-canonical-screener-5y'
        Prefix = 'archives/d1_audit_json_archive/target=canonical_screener_funnel_items/'
        IaDays = 90
        ExpireDays = 1825
    },
    @{
        Id = 'sv-audit-noncanonical-screener-2y'
        Prefix = 'archives/d1_audit_json_archive/target=screener_funnel_items/'
        IaDays = 90
        ExpireDays = 730
    },
    @{
        Id = 'sv-audit-paper-execution-2y'
        Prefix = 'archives/d1_audit_json_archive/target=paper_execution_events/'
        IaDays = 90
        ExpireDays = 730
    }
)

Write-Output "R2 bucket: $BucketName"
Write-Output 'Existing lifecycle rules:'
& npx.cmd wrangler@4 r2 bucket lifecycle list $BucketName

foreach ($rule in $rules) {
    $command = "npx wrangler@4 r2 bucket lifecycle add $BucketName $($rule.Id) $($rule.Prefix) --ia-transition-days $($rule.IaDays) --expire-days $($rule.ExpireDays)"
    if (-not $Apply) {
        Write-Output "DRY-RUN: $command"
        continue
    }
    if ($Confirm -ne $requiredConfirm) {
        throw "Confirmation must equal $requiredConfirm"
    }
    & npx.cmd wrangler@4 r2 bucket lifecycle add `
        $BucketName `
        $rule.Id `
        $rule.Prefix `
        --ia-transition-days $rule.IaDays `
        --expire-days $rule.ExpireDays
}

if ($Apply) {
    Write-Output 'Lifecycle rules after apply:'
    & npx.cmd wrangler@4 r2 bucket lifecycle list $BucketName
}
