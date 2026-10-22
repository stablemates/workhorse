using System.Text.Json;

namespace Workhorse.AspNetCore;

/// <summary>
/// One <c>dashboard/v1</c> procedure that the host application supplies, such as <c>enqueueTest</c>.
/// </summary>
/// <param name="input">
/// The request's <c>json</c> value after schema validation. An <c>audit</c> object carries the
/// authenticated actor, not the value that the browser sent.
/// </param>
/// <param name="actor">The authenticated actor, a <see cref="string"/>.</param>
/// <param name="cancellationToken">Cancels the call when the client disconnects.</param>
/// <returns>
/// The result, which the dashboard encodes with <see cref="DashboardOptions.Json"/>. A <c>null</c>
/// result answers <c>{}</c>. Throw <see cref="DashboardRpcException"/> to refuse the call with an
/// RPC status and code. The dashboard answers any other exception with 500 and no detail.
/// </returns>
public delegate ValueTask<object?> DashboardProcedure(JsonElement input, object? actor, CancellationToken cancellationToken);
